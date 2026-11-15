
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../apps/cli/src/main.mjs', import.meta.url));
const preload = new URL('./fixtures/codex-run-preload.mjs', import.meta.url).href;
const prompt = 'PRIVATE_PROMPT_MARKER';

async function waitForApproval(query, id, signal) {
  for (;;) {
    const { events } = await query('run', 'events', id);
    const approval = events.find(event => event.type === 'approval_requested');
    if (approval) return approval;
    await delay(50, null, { signal });
  }
}

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'organis-codex-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const project = path.join(root, 'project');
  await mkdir(project);
  const args = (...command) => [cli, ...command, '--state-dir', state, '--json'];
  const query = async (...command) => JSON.parse((await execute(process.execPath, args(...command))).stdout);
  const { project: registration } = await query('project', 'add', project);
  const start = (scenario, promptArgs = ['--prompt', prompt]) => {
    const child = spawn(process.execPath, ['--import', preload,
      ...args('run', 'codex', registration.id, '--executable', process.execPath, ...promptArgs)], {
      env: { ...process.env, ORGANIS_TEST_CODEX_SCENARIO: scenario },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    const closed = once(child, 'close');
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const next = async () => {
      const line = await lines.next();
      assert.equal(line.done, false, 'CLI exited before emitting the expected record');
      return JSON.parse(line.value);
    };
    return { next, closed, stop: () => child.kill('SIGKILL') };
  };
  return { start, query, project, registration };
}

test('CLI records one completed Codex turn and a bounded answer with ordered events', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  const launched = start('complete');
  const accepted = await launched.next();
  const { run, answer } = await launched.next();
  assert.equal(accepted.run.id, run.id);
  assert.equal((await launched.closed)[0], 0);
  assert.equal(run.state, 'completed');
  assert.equal(run.scope, 'read-only');
  assert.equal(answer, 'SYNTHETIC_ANSWER');
  assert.deepEqual((await query('run', 'show', run.id)).run, run);
  assert.equal((await query('run', 'list')).runs[0].id, run.id);
  const { events } = await query('run', 'events', run.id);
  assert.deepEqual(events.map(event => event.type), [
    'run_created', 'launch_requested', 'process_started', 'codex_process_ready', 'codex_turn_started',
    'codex_process_closed', 'codex_answer', 'completed'
  ]);
  assert.equal(events[4].threadId, 'fixture-thread');
  assert.equal(events[4].turnId, 'fixture-turn');
  assert.deepEqual((await query('run', 'events', run.id, '--after', String(events[4].sequence))).events, events.slice(5));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_PROMPT_MARKER|private-email-marker/);
});

test('CLI sends an inline option-like prompt as literal text', { timeout: 15000 }, async t => {
  const { start, query, registration } = await setup(t);
  const launched = start('option-like-prompt', ['--prompt=--help']);
  await launched.next();
  const { run } = await launched.next();
  assert.equal((await launched.closed)[0], 0);
  assert.equal(run.state, 'completed');
  for (const args of [['--prompt'], ['--prompt='], ['--prompt=--help', '--prompt', 'duplicate']]) {
    await assert.rejects(query('run', 'codex', registration.id, ...args), { code: 2 });
  }
  assert.equal((await query('run', 'list')).runs.length, 1);
});

test('CLI saves the provider failure and never submits a turn for an unverified policy', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  for (const [scenario, errorCode] of [
    ['failure', 'CODEX_RUN_FAILED'], ['policy', 'CODEX_POLICY_UNVERIFIED'],
    ['mcp', 'CODEX_MCP_UNSUPPORTED'], ['managed-tool', 'CODEX_POLICY_UNVERIFIED']
  ]) {
    const launched = start(scenario);
    await launched.next();
    const { run } = await launched.next();
    assert.equal((await launched.closed)[0], 1);
    assert.equal(run.state, 'failed');
    assert.equal(run.errorCode, errorCode);
    const { events } = await query('run', 'events', run.id);
    assert.equal(events.at(-1).type, 'failed');
    assert.equal(events.some(event => event.type === 'codex_turn_started'), scenario === 'failure');
    assert(!events.some(event => event.type === 'codex_answer'));
  }
});

test('another CLI can cancel an active Codex turn and observe the same terminal record', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  for (const scenario of ['wait', 'unconfirmed']) {
    const launched = start(scenario);
    const { run: { id } } = await launched.next();
    while (!(await query('run', 'events', id)).events.some(event => event.type === 'codex_turn_started')) {
      await delay(50, null, { signal: t.signal });
    }
    const request = await query('run', 'cancel', id);
    assert.equal(request.run.state, 'cancelling');
    const { run } = await launched.next();
    const verified = scenario === 'wait';
    assert.equal((await launched.closed)[0], verified ? 130 : 1);
    assert.equal(run.state, verified ? 'cancelled' : 'interrupted');
    assert.equal(run.ownershipRetained, false);
    assert.deepEqual((await query('run', 'show', id)).run, run);
    assert.equal((await query('run', 'events', id)).events.at(-1).type, run.state);
  }
});

test('an owner crash before confirmed Codex shutdown retains the workspace lease', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  const launched = start('approval');
  const { run: { id } } = await launched.next();
  const { approvalId } = await waitForApproval(query, id, t.signal);
  launched.stop();
  await launched.closed;
  await query('run', 'reconcile');
  const { run } = await query('run', 'show', id);
  assert.equal(run.state, 'interrupted');
  assert.equal(run.errorCode, 'OWNER_LOST');
  assert.equal(run.ownershipRetained, true);
  assert.equal(run.approvalState, 'not_required');
  assert((await query('run', 'events', id)).events.some(event =>
    event.type === 'approval_invalidated' && event.approvalId === approvalId && event.reason === 'owner_lost'));
});

test('CLI waits for a durable denial and sends only a negative provider response', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  for (const scenario of ['approval-early', 'approval-permissions']) {
    const launched = start(scenario);
    const { run: { id } } = await launched.next();
    const { approvalId } = await waitForApproval(query, id, t.signal);
    const { run: waiting } = await query('run', 'show', id);
    assert.equal(waiting.state, 'awaiting_approval');
    assert.equal(waiting.approvalState, 'pending');
    await assert.rejects(query('run', 'deny', id, '00000000-0000-0000-0000-000000000000'), /APPROVAL_NOT_PENDING/);
    const submissions = await Promise.allSettled([query('run', 'deny', id, approvalId), query('run', 'deny', id, approvalId)]);
    assert.deepEqual(submissions.map(item => item.status).sort(), ['fulfilled', 'rejected']);
    const { run } = await launched.next();
    assert.equal(run.state, 'completed');
    assert.equal(run.approvalState, 'rejected');
    assert.equal((await launched.closed)[0], 0);
    const { events } = await query('run', 'events', id);
    assert.deepEqual(events.filter(event => event.type.startsWith('approval_')).map(event => [event.type, event.approvalId]),
      [['approval_requested', approvalId], ['approval_denied', approvalId]]);
    assert.doesNotMatch(JSON.stringify(events), /private-command-marker|network|itemId/);
  }
});

test('cancelling a pending approval invalidates it and interrupts the turn', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  const launched = start('approval');
  const { run: { id } } = await launched.next();
  const { approvalId } = await waitForApproval(query, id, t.signal);
  const { run: cancel } = await query('run', 'cancel', id);
  assert.equal(cancel.state, 'cancelling');
  assert.equal(cancel.approvalState, 'not_required');
  await assert.rejects(query('run', 'deny', id, approvalId), /APPROVAL_NOT_PENDING/);
  assert.equal((await launched.next()).run.state, 'cancelled');
  assert.equal((await launched.closed)[0], 130);
  assert.deepEqual((await query('run', 'events', id)).events.filter(event => event.type.startsWith('approval_'))
    .map(event => [event.type, event.approvalId]), [['approval_requested', approvalId], ['approval_invalidated', approvalId]]);
});

test('an IPC denial delivery failure preserves the committed denial and interrupts ownership', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  const launched = start('approval-delivery-failure');
  const { run: { id } } = await launched.next();
  const { approvalId } = await waitForApproval(query, id, t.signal);
  await query('run', 'deny', id, approvalId);
  const { run } = await launched.next();
  assert.equal((await launched.closed)[0], 1);
  assert.equal(run.state, 'interrupted');
  assert.equal(run.ownershipRetained, true);
  const { events } = await query('run', 'events', id);
  assert.deepEqual(events.filter(event => event.type.startsWith('approval_')).map(event => [event.type, event.approvalId]),
    [['approval_requested', approvalId], ['approval_denied', approvalId], ['approval_denial_delivery_failed', approvalId]]);
  await assert.rejects(query('run', 'deny', id, approvalId), /APPROVAL_NOT_PENDING/);
});

test('an unsolicited terminal notification cannot finish a run with a pending approval', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  const launched = start('approval-ended');
  const { run: { id } } = await launched.next();
  const { run } = await launched.next();
  assert.equal((await launched.closed)[0], 1);
  assert.equal(run.state, 'failed');
  assert.equal(run.approvalState, 'not_required');
  assert((await query('run', 'events', id)).events.some(event =>
    event.type === 'approval_invalidated' && event.reason === 'run_ended'));
});

test('the read-only preview blocks projects with additional path rules', { timeout: 15000 }, async t => {
  const { registration, project, query } = await setup(t);
  await query('project', 'set-path', registration.id, project, '--access', 'deny');
  await assert.rejects(query('run', 'codex', registration.id, '--prompt', prompt), { code: 1 });
  assert.equal((await query('run', 'list')).runs.length, 0);
});

for (const scenario of ['unsafe', 'unexpected-request']) {
  test('the ' + scenario + ' protocol case retains workspace ownership', { timeout: 15000 }, async t => {
    const { start, query } = await setup(t);
    const launched = start(scenario);
    const { run: { id } } = await launched.next();
    const { run } = await launched.next();
    assert.equal((await launched.closed)[0], 1);
    assert.equal(run.state, 'interrupted');
    assert.equal(run.ownershipRetained, true);
    await query('run', 'reconcile');
    assert.equal((await query('run', 'show', id)).run.ownershipRetained, true);
    const { events } = await query('run', 'events', id);
    assert.equal(events.filter(event => event.type === 'codex_containment_unverified').length, 1);
  });
}

test('a new MCP configuration detected after thread creation prevents turn submission', { timeout: 15000 }, async t => {
  const { start, query } = await setup(t);
  const launched = start('mcp-appeared');
  const { run: { id } } = await launched.next();
  const { run } = await launched.next();
  assert.equal((await launched.closed)[0], 1);
  assert.equal(run.state, 'interrupted');
  assert.equal(run.ownershipRetained, true);
  const { events } = await query('run', 'events', id);
  assert(!events.some(event => event.type === 'codex_turn_started'));
  assert(events.some(event => event.type === 'codex_containment_unverified'));
});
