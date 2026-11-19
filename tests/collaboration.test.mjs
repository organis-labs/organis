import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCollaboration, openCollaborationJournal } from '../packages/runtime/src/collaboration.mts';
import { createClaudeTaskRunner } from '../packages/runtime/src/claude.mjs';

function fixture(t, { empty = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'organis-collaboration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectId = randomUUID();
  const target = path.join(directory, 'note.txt');
  const inputs = [];
  const state = { now: 1000, text: 'original\n', identity: 'original', replacement: 'approved\n',
    writes: 0, picks: 0, approve: true, discard: 0, verdict: 'passed' };
  const journal = openCollaborationJournal(directory);
  const plan = { summary: 'Change one line.', instructions: 'Replace original.', criteria: ['Keep the newline.'] };
  const deps = {
    journal, now: () => state.now,
    selectFile: async () => { state.picks++; return target; },
    inspect: async (project, selected) => {
      assert.equal(project, projectId);
      assert.equal(selected, target);
      return { workspace: { fileId: 'root' }, file: { identity: state.identity, text: state.text, target } };
    },
    claude: async ({ stage, input, runId }) => {
      inputs.push({ agent: 'claude', stage, input, runId });
      return stage === 'plan' ? plan : { verdict: state.verdict, summary: 'Refine the same line.' };
    },
    fileChange: {
      isPending: () => false,
      start: async ({ projectId: project, instructions }, selection) => {
        assert.equal(project, projectId);
        assert.equal(selection.target, target);
        assert.equal(selection.expected.file.text, state.text);
        selection.onRun('codex-provider-run-' + state.writes);
        inputs.push({ agent: 'codex', instructions, roomId: selection.roomId, participantId: selection.participantId });
        return { id: 'native-proposal', target, original: state.text, replacement: state.replacement };
      },
      approve: async (id, authorize) => {
        assert.equal(id, 'native-proposal');
        if (!state.approve) return false;
        authorize();
        state.writes++;
        state.text = state.replacement;
        state.identity = 'written-' + state.writes;
        return true;
      },
      discard: async () => { state.discard++; }
    },
    verifyCodexTermination: async () => false
  };
  const room = createCollaboration(deps);
  let roomId;
  if (!empty) {
    roomId = room.createRoom('Changes').selectedRoomId;
    room.addParticipant(roomId, 'claude');
    room.addParticipant(roomId, 'codex');
  }
  const request = { roomId, projectId, request: 'User goal', commandId: randomUUID() };
  async function untilProposal() {
    const task = await room.prepare(request);
    await room.plan(task.id, task.attempt);
    return room.propose(task.id, task.attempt);
  }
  return { deps, directory, inputs, journal, plan, projectId, request, room, state, target, untilProposal };
}

test('saved rooms keep their participants and collaboration when the journal reopens', async t => {
  const f = fixture(t, { empty: true });
  assert.deepEqual(f.room.listRooms(), { selectedRoomId: null, rooms: [] });
  const first = f.room.createRoom('First room').selectedRoomId;
  const other = f.room.createRoom('Other room').selectedRoomId;
  f.room.openRoom(first);
  const request = { ...f.request, roomId: first };
  await assert.rejects(f.room.prepare(request), /Add Claude and Codex/);
  f.room.addParticipant(first, 'claude');
  const { rooms: [savedRoom] } = f.room.addParticipant(first, 'codex');
  assert.deepEqual(f.room.addParticipant(first, 'claude').rooms[0], savedRoom);

  const prepare = f.room.prepare(request);
  assert.throws(() => f.room.openRoom(other), /Finish or cancel/);
  const task = await prepare;
  assert.equal(task.roomId, first);
  assert.deepEqual(task.participants, savedRoom.participants);
  assert.throws(() => f.room.createRoom('Not yet'), /Finish or cancel/);
  await f.room.plan(task.id, task.attempt);
  await f.room.propose(task.id, task.attempt);
  assert.throws(() => f.room.openRoom(other), /Finish or cancel/);
  await f.room.apply(task.id, task.attempt);
  assert.equal(f.inputs[1].roomId, first);
  assert.equal(f.inputs[1].participantId, savedRoom.participants.codex);

  const restored = createCollaboration({ ...f.deps, journal: openCollaborationJournal(f.directory) });
  assert.equal(restored.listRooms().selectedRoomId, first);
  assert.deepEqual(restored.listRooms().rooms[0], savedRoom);
  const pendingReview = await restored.status();
  assert.equal(pendingReview.phase, 'ready-to-review');
  assert.equal(pendingReview.id, task.id);
  assert.equal(pendingReview.runs.at(-1).stage, 'apply');
  assert.equal(f.inputs.length, 2);
  const completed = await restored.review(task.id, task.attempt);
  assert.equal(completed.phase, 'completed');
  assert.equal(f.state.writes, 1);

  restored.openRoom(other);
  assert.equal(await restored.status(), null);
  await assert.rejects(restored.prepare(request), /Open the room again/);
  const reopened = createCollaboration({ ...f.deps, journal: openCollaborationJournal(f.directory) });
  assert.equal(reopened.listRooms().selectedRoomId, other);
  reopened.openRoom(first);
  assert.deepEqual(await reopened.status(), completed);
});

test('a legacy task keeps its room, participants and recovery behavior', async t => {
  const f = fixture(t);
  const task = await f.room.prepare(f.request);
  writeFileSync(path.join(f.directory, 'collaboration.json'), JSON.stringify({ schema: 1, task: f.journal.read() }));
  const restored = createCollaboration({ ...f.deps, journal: openCollaborationJournal(f.directory) });
  assert.deepEqual(restored.listRooms(), { selectedRoomId: task.roomId,
    rooms: [{ id: task.roomId, name: 'Local collaboration', participants: task.participants }] });
  const result = await restored.status();
  assert.equal(result.id, task.id);
  assert.equal(result.phase, 'interrupted');
  assert.equal(f.inputs.length, 0);
});

test('one room binds the real handoff shape, a native approval and verified test evidence', async t => {
  const f = fixture(t);
  const task = await f.room.prepare(f.request);
  assert.equal(task.phase, 'ready-to-plan');
  assert.equal((await f.room.prepare(f.request)).id, task.id);
  assert.equal(f.state.picks, 1);
  assert.equal(f.inputs.length, 0);
  await assert.rejects(f.room.prepare({ ...f.request, request: 'different request' }), /already used/);
  const { id, attempt } = task;
  await f.room.plan(id, attempt);
  assert.deepEqual(f.inputs[0].input, { request: 'User goal', fileName: 'note.txt' });
  const pending = await f.room.propose(id, attempt);
  assert.equal(pending.phase, 'awaiting-approval');
  assert.equal(pending.runs[1].id, 'codex-provider-run-0');
  assert.equal(f.inputs[1].instructions, 'Replace original.\n\nAcceptance criteria:\n- Keep the newline.');
  assert.equal(f.state.text, 'original\n');
  const applied = await f.room.apply(id, attempt);
  assert.equal(applied.phase, 'ready-to-review');
  assert.equal(applied.applied, true);
  assert.equal(applied.runs[2].approvedAt, f.state.now);
  await assert.rejects(f.room.apply(id, attempt), /unavailable/);
  assert.equal(f.state.writes, 1);
  const evidence = { command: 'node verify.mjs', actor: 'User', exitCode: 0, result: 'Verified replacement.', revision: applied.revision };
  await assert.rejects(f.room.recordTest({ id, attempt, ...evidence, revision: 'wrong' }), /applied revision/);
  await f.room.recordTest({ id, attempt, ...evidence });
  const done = await f.room.review(id, attempt);
  assert.equal(done.phase, 'completed');
  assert.equal(done.review.verdict, 'passed');
  assert.deepEqual(f.inputs[2].input,
    { plan: { summary: f.plan.summary, criteria: f.plan.criteria }, fileName: 'note.txt',
      original: 'original\n', replacement: 'approved\n', tests: [evidence] });
  assert.equal(f.journal.read().phase, 'completed');
  await f.room.dismiss(id, attempt);
  assert.equal(await f.room.status(), null);
  assert(!Object.hasOwn(f.journal.read(), 'original'));
  assert.equal(await f.room.prepare(f.request), null);
});

test('decline and approval expiry leave original content alone and skip review', async t => {
  const declined = fixture(t);
  const task = await declined.untilProposal();
  declined.state.approve = false;
  assert.equal((await declined.room.apply(task.id, task.attempt)).phase, 'cancelled');
  assert.equal(declined.state.writes, 0);
  assert.equal(declined.inputs.length, 2);

  const expired = fixture(t);
  const pending = await expired.untilProposal();
  expired.state.now = pending.approvalExpiresAt;
  assert.equal((await expired.room.apply(pending.id, pending.attempt)).phase, 'cancelled');
  assert.equal(expired.state.discard, 1);
  assert.equal(expired.state.text, 'original\n');
  assert.equal(expired.state.writes, 0);
});

test('source versions are checked again before the first Claude send and the Codex handoff', async t => {
  const f = fixture(t);
  const task = await f.room.prepare(f.request);
  f.state.identity = 'replaced-after-pick';
  assert.equal((await f.room.plan(task.id, task.attempt)).phase, 'failed');
  assert.deepEqual(f.inputs, []);

  const rebuilt = await f.room.prepare({ ...f.request, commandId: randomUUID() });
  await f.room.plan(rebuilt.id, rebuilt.attempt);
  f.state.text = 'different after planning';
  assert.equal((await f.room.propose(rebuilt.id, rebuilt.attempt)).phase, 'failed');
  assert.equal(f.inputs.length, 1);
  assert.equal(f.state.writes, 0);
});

test('a revision must be confirmed and approved again, and a second revision is blocked', async t => {
  const f = fixture(t);
  const first = await f.untilProposal();
  f.state.verdict = 'revision';
  await f.room.apply(first.id, first.attempt);
  assert.equal((await f.room.review(first.id, 1)).phase, 'revision-requested');
  const next = await f.room.revise(first.id, 1);
  assert.equal(next.attempt, 2);
  assert.equal(next.original, 'approved\n');
  assert.equal(next.history[0].proposal.replacement, 'approved\n');
  await assert.rejects(f.room.apply(first.id, 1), /no longer available/);
  f.state.replacement = 'approved revision\n';
  const proposed = await f.room.propose(first.id, 2);
  assert.equal(proposed.phase, 'awaiting-approval');
  assert.equal(f.state.writes, 1);
  assert.match(f.inputs.at(-1).instructions, /^Refine the same line/);
  await f.room.apply(first.id, 2);
  assert.equal((await f.room.review(first.id, 2)).phase, 'revision-limit');
  await assert.rejects(f.room.revise(first.id, 2), /unavailable/);
  assert.equal(f.state.writes, 2);
});

test('cancellation waits for Codex termination and blocks new collaboration meanwhile', async t => {
  const f = fixture(t);
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  f.deps.fileChange.start = async (_options, selection) => {
    selection.onRun('in-progress');
    started.resolve();
    return stopped.promise;
  };
  f.deps.fileChange.discard = () => stopped.promise;
  const task = await f.room.prepare(f.request);
  await f.room.plan(task.id, task.attempt);
  const launch = f.room.propose(task.id, task.attempt);
  await started.promise;
  const cancel = f.room.cancel(task.id, task.attempt);
  assert.equal((await f.room.status()).phase, 'cancelling');
  await assert.rejects(f.room.prepare({ ...f.request, commandId: randomUUID() }), /current file change or collaboration/);
  stopped.resolve(null);
  assert.equal((await launch).phase, 'cancelled');
  assert.equal((await cancel).phase, 'cancelled');
  assert.equal(f.state.writes, 0);
});

test('a restart invalidates pending approval and reports uncertain writes without replay', async t => {
  const pending = fixture(t);
  const awaiting = await pending.untilProposal();
  const reopened = createCollaboration(pending.deps);
  assert.equal((await reopened.status()).phase, 'interrupted');
  await assert.rejects(reopened.apply(awaiting.id, awaiting.attempt), /unavailable/);
  assert.equal(pending.state.writes, 0);

  const writing = fixture(t);
  const task = await writing.untilProposal();
  writing.journal.write({ ...writing.journal.read(), phase: 'applying' });
  const uncertain = createCollaboration(writing.deps);
  const snapshot = await uncertain.status();
  assert.equal(snapshot.phase, 'verification-required');
  assert.equal(snapshot.canAcknowledgeUncertainWrite, true);
  assert.equal(snapshot.applied, false);
  await assert.rejects(uncertain.apply(task.id, task.attempt), /unavailable/);
  assert.equal(writing.state.writes, 0);
  assert.equal(await uncertain.dismiss(task.id, task.attempt), null);
});

test('the desktop handoff is accepted by the real Claude task adapter', async t => {
  const f = fixture(t);
  const profileRoot = path.join(path.dirname(f.target), 'claude');
  const options = [];
  const runClaudeTask = createClaudeTaskRunner({ profileRoot, execute: async (_executable, args, request) => {
    if (args.includes('--version')) return { exitCode: 0, stdout: '2.1.316 (Claude Code)' };
    if (args.includes('status')) return { exitCode: 0, stdout: JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', configDirectory: request.env.CLAUDE_CONFIG_DIR
    }) };
    const session = args[args.indexOf('--session-id') + 1];
    const input = JSON.parse(request.input.slice(request.input.indexOf('\n') + 1));
    options.push(input);
    return { exitCode: 0, stdout: JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, session_id: session,
      structured_output: options.length === 1 ? f.plan : { verdict: 'passed', summary: 'Verified.' }
    }) };
  } });
  const room = createCollaboration({ ...f.deps, claude: input => runClaudeTask({ ...input, executable: process.execPath }) });
  const { id, attempt } = await room.prepare(f.request);
  assert.equal((await room.plan(id, attempt)).phase, 'ready-to-propose');
  await room.propose(id, attempt);
  await room.apply(id, attempt);
  assert.equal((await room.review(id, attempt)).phase, 'completed');
  assert.deepEqual(options[1].plan, { summary: f.plan.summary, criteria: f.plan.criteria });
  assert.equal(options[1].replacement, 'approved\n');
});

test('restart before provider launch frees the room only after checking ownership', async t => {
  const f = fixture(t);
  const task = await f.room.prepare(f.request);
  const run = { id: randomUUID(), stage: 'plan', state: 'running' };
  f.journal.write({ ...f.journal.read(), phase: 'planning', runs: [run] });
  assert.equal((await createCollaboration(f.deps).status()).phase, 'interrupted');

  const commandId = randomUUID();
  f.journal.write({ ...f.journal.read(), phase: 'proposing',
    runs: [{ id: commandId, stage: 'codex', state: 'running' }] });
  let confirmed = false;
  const reopened = createCollaboration({ ...f.deps, verifyCodexTermination: async (id, command) => {
    assert.equal(id, commandId);
    assert.equal(command, commandId);
    return confirmed;
  } });
  assert.equal((await reopened.status()).phase, 'verification-required');
  await assert.rejects(reopened.dismiss(task.id, task.attempt), /before clearing/);
  confirmed = true;
  assert.equal((await reopened.status()).phase, 'interrupted');
});

test('a stopped review can be requested again without reapplying the approved file', async t => {
  const f = fixture(t);
  const { id, attempt } = await f.untilProposal();
  const applied = await f.room.apply(id, attempt);
  const previous = f.journal.read();
  f.journal.write({ ...previous, phase: 'reviewing',
    runs: [...previous.runs, { id: randomUUID(), stage: 'review', attempt, state: 'running' }] });

  const reopened = createCollaboration(f.deps);
  const recovered = await reopened.status();
  assert.equal(recovered.phase, 'ready-to-review');
  assert.equal(recovered.runs.at(-1).state, 'interrupted');
  assert.equal(recovered.revision, applied.revision);
  assert.equal(f.inputs.length, 2);
  const reviewed = await reopened.review(id, attempt);
  assert.equal(reviewed.phase, 'completed');
  assert.equal(reviewed.review.verdict, 'passed');
  assert.equal(f.state.writes, 1);
});

test('a review result is rejected if the approved revision changes during review', async t => {
  const f = fixture(t);
  const claude = f.deps.claude;
  const responding = Promise.withResolvers();
  const started = Promise.withResolvers();
  const room = createCollaboration({ ...f.deps, claude: options => {
    if (options.stage !== 'review') return claude(options);
    started.resolve();
    return responding.promise;
  } });
  const { id, attempt } = await room.prepare(f.request);
  await room.plan(id, attempt);
  await room.propose(id, attempt);
  await room.apply(id, attempt);
  const review = room.review(id, attempt);
  await started.promise;
  f.state.text = 'An edit made during the review.\n';
  responding.resolve({ verdict: 'passed', summary: 'Matches the reviewed text.' });
  const result = await review;
  assert.equal(result.phase, 'failed');
  assert.equal(result.review, undefined);
  assert.equal(result.applied, true);
  assert.match(result.message, /changed since approval/);
  assert.equal(f.state.writes, 1);
});
