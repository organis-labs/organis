import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CollaborationPhase, CollaborationPlan, CollaborationProvider, CollaborationRequest, CollaborationReview,
  CollaborationRoom, CollaborationRooms, CollaborationRun, CollaborationSnapshot, RecordTestRequest } from './collaboration-types.mjs';
import type { FileChange } from './execution-types.mjs';
import type { LocalRuntime } from './execution.mjs';

type TargetSelection = Awaited<ReturnType<LocalRuntime['inspectCodexFileChangeTarget']>>;
type Fingerprint = { workspaceId: string; identity: string; revision: string };
type StoredRun = CollaborationRun & { pid?: number };
type StoredTask = Omit<CollaborationSnapshot, 'canAcknowledgeUncertainWrite' | 'runs'> & {
  dismissed?: false;
  commandId: string;
  requestHash: string;
  fingerprint: Fingerprint;
  interruptedStage?: CollaborationRun['stage'] | null;
  runs: StoredRun[];
};
type DismissedTask = Pick<StoredTask, 'id' | 'roomId' | 'attempt' | 'commandId' | 'requestHash' | 'phase' | 'updatedAt'>
  & { dismissed: true };
type JournalTask = StoredTask | DismissedTask;
type StoredRoom = CollaborationRoom & { task: JournalTask | null };
type RoomJournal = { schema: 2; selectedRoomId: string | null; rooms: StoredRoom[] };
type LegacyJournal = { schema: 1; task: JournalTask };
type ClaudeTask = { signal: AbortSignal; runId: string; onSpawn: (pid: number) => void } & (
  { stage: 'plan'; input: { request: string; fileName: string } }
  | { stage: 'review'; input: {
    plan: Pick<CollaborationPlan, 'summary' | 'criteria'>;
    fileName: string;
    original: string;
    replacement: string;
    tests: CollaborationSnapshot['tests'];
  } }
);
type StageOutcome = Partial<StoredTask> & Pick<StoredTask, 'phase' | 'message'>;
type StageOperation = {
  controller: AbortController;
  abortChild?: () => Promise<unknown>;
  promise?: Promise<CollaborationSnapshot | null>;
  cancellation?: Promise<unknown>;
  writeAuthorized?: boolean;
};
interface CollaborationOptions {
  journal: ReturnType<typeof openCollaborationJournal>;
  selectFile: () => Promise<string | null>;
  inspect: (projectId: string, target: string) => Promise<TargetSelection>;
  claude: (options: ClaudeTask) => Promise<CollaborationPlan | CollaborationReview>;
  fileChange: {
    isPending(): boolean;
    start(input: { projectId: string; instructions: string }, selection: {
      target: string; expected?: TargetSelection; roomId: string; participantId: string; commandId: string;
      onRun: (id: string) => void;
    }): Promise<(FileChange & { id: string }) | null>;
    approve(id: string, beforeApply: () => void): Promise<boolean>;
    discard(): Promise<unknown>;
  };
  verifyCodexTermination: (id?: string, commandId?: string) => Promise<boolean>;
  now?: () => number;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
}

const terminal = new Set<CollaborationPhase>(['completed', 'cancelled', 'failed', 'interrupted', 'revision-limit']);
const approvalLifetime = 10 * 60 * 1000;
const maxRevisions = 1;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid = (message: string) => new Error(message);
const version = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const pendingApprovalPhases = new Set<CollaborationPhase>(['awaiting-approval', 'applying']);

function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.isWellFormed() &&
    !value.includes('\0') && Buffer.byteLength(value) <= limit;
}

function processIsGone(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return errorCode(error) === 'ESRCH'; }
}

export function openCollaborationJournal(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'collaboration.json');
  let state: RoomJournal = { schema: 2, selectedRoomId: null, rooms: [] };
  const validTask = (task: JournalTask) => uuid.test(task?.id ?? '') && typeof task.phase === 'string';
  const providers: readonly CollaborationProvider[] = ['claude', 'codex'];
  function validRoom(room: StoredRoom) {
    if (!uuid.test(room?.id ?? '') || !validText(room.name, 100) || !room.participants
      || typeof room.participants !== 'object' || Array.isArray(room.participants)
      || !Object.entries(room.participants).every(([provider, id]) => providers.some(candidate => candidate === provider) && typeof id === 'string' && uuid.test(id))) return false;
    const { task } = room;
    return task === null || (validTask(task) && task.roomId === room.id && (task.dismissed
      || providers.every(provider => uuid.test(room.participants[provider] ?? '')
        && room.participants[provider] === task.participants?.[provider])));
  }
  try {
    const record: LegacyJournal | RoomJournal = JSON.parse(readFileSync(target, 'utf8'));
    if (record.schema === 1 && validTask(record.task)) {
      if (!record.task.dismissed) {
        const { roomId, participants } = record.task;
        state = { schema: 2, selectedRoomId: roomId,
          rooms: [{ id: roomId, name: 'Local collaboration', participants, task: record.task }] };
      }
    } else if (record.schema === 2) {
      state = record;
    } else {
      throw invalid('Unsupported collaboration journal.');
    }
    if (!Array.isArray(state.rooms) || !state.rooms.every(validRoom)
      || new Set(state.rooms.map(room => room.id)).size !== state.rooms.length
      || (state.rooms.length ? !state.rooms.some(room => room.id === state.selectedRoomId) : state.selectedRoomId !== null)) {
      throw invalid('Unsupported collaboration journal.');
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  function commit(next: RoomJournal) {
    const temp = path.join(directory, `collaboration-${randomUUID()}.next`);
    const file = openSync(temp, 'wx', 0o600);
    try {
      try {
        writeFileSync(file, JSON.stringify(next), 'utf8');
        fsyncSync(file);
      } finally { closeSync(file); }
      renameSync(temp, target);
      state = next;
    } finally { rmSync(temp, { force: true }); }
  }

  const selected = () => state.rooms.find(room => room.id === state.selectedRoomId);
  function updateRoom(changes: Partial<StoredRoom>) {
    commit({ ...state, rooms: state.rooms.map(room => room.id === state.selectedRoomId ? { ...room, ...changes } : room) });
  }

  return {
    list(): CollaborationRooms {
      return { selectedRoomId: state.selectedRoomId,
        rooms: state.rooms.map(({ id, name, participants }) => ({ id, name, participants: { ...participants } })) };
    },
    create(name: unknown) {
      if (!validText(name, 100)) throw invalid('Enter a room name of up to 100 bytes.');
      const room = { id: randomUUID(), name: name.trim(), participants: {}, task: null };
      commit({ ...state, selectedRoomId: room.id, rooms: [...state.rooms, room] });
    },
    select(id: string) {
      if (!state.rooms.some(room => room.id === id)) throw invalid('This room is unavailable.');
      if (state.selectedRoomId !== id) commit({ ...state, selectedRoomId: id });
    },
    addParticipant(id: string, provider: CollaborationProvider) {
      const room = selected();
      if (!room || room.id !== id || !providers.includes(provider)) throw invalid('Select a room and a supported participant.');
      if (!room.participants[provider]) updateRoom({ participants: { ...room.participants, [provider]: randomUUID() } });
    },
    read: () => selected()?.task ?? null,
    write(task: JournalTask) {
      if (!selected() || task.roomId !== state.selectedRoomId) throw invalid('The collaboration belongs to a different room.');
      updateRoom({ task });
    }
  };
}

export function createCollaboration({
  journal, selectFile, inspect, claude, fileChange, verifyCodexTermination, now = Date.now
}: CollaborationOptions) {
  let task: JournalTask | null;
  let preparing = false;
  let operation: StageOperation | undefined;
  let expected: TargetSelection | undefined;
  let proposalId: string | undefined;
  let closing = false;

  function save(next: JournalTask) {
    journal.write(next);
    task = next;
  }
  function activeTask(): StoredTask {
    if (!task || task.dismissed) throw invalid('This collaboration attempt is no longer available.');
    return task;
  }
  function set(changes: Partial<StoredTask>) { save({ ...activeTask(), ...changes, updatedAt: now() }); }
  function view(): CollaborationSnapshot | null {
    if (!task || task.dismissed) return null;
    const { commandId, requestHash, fingerprint, interruptedStage, dismissed, runs, ...snapshot } = task;
    return structuredClone({ ...snapshot, runs: runs.map(({ pid, ...run }) => run),
      canAcknowledgeUncertainWrite: snapshot.phase === 'verification-required' && interruptedStage === 'apply' });
  }
  function move(phase: CollaborationPhase, message: string, changes: Partial<StoredTask> = {}) { set({ ...changes, phase, message }); }
  function busy() { return preparing || Boolean(task && !terminal.has(task.phase)); }
  function requireTask(id: string, attempt: number): StoredTask {
    if (closing || !task || task.dismissed || task.id !== id || task.attempt !== attempt) {
      throw invalid('This collaboration attempt is no longer available.');
    }
    return task;
  }
  function expect(id: string, attempt: number, phase: CollaborationPhase): StoredTask {
    const current = requireTask(id, attempt);
    if (operation || current.phase !== phase) throw invalid('This action is unavailable in the current phase.');
    return current;
  }
  function currentRun() { return activeTask().runs.at(-1); }
  function updateRun(fields: Partial<StoredRun>) {
    const task = activeTask();
    const run = task.runs.at(-1);
    if (!run) throw invalid('No collaboration stage is recorded.');
    return [...task.runs.slice(0, -1), { ...run, ...fields }];
  }
  function fingerprint(selection: TargetSelection): Fingerprint {
    return { workspaceId: selection.workspace.fileId, identity: selection.file.identity, revision: version(selection.file.text) };
  }
  function assertSource(selection: TargetSelection) {
    const { workspaceId, identity, revision } = fingerprint(selection);
    const saved = activeTask().fingerprint;
    if (workspaceId !== saved.workspaceId || identity !== saved.identity || revision !== saved.revision) {
      throw invalid('The selected file changed. Start a new collaboration with the current file.');
    }
  }

  function restore() {
    task = journal.read();
    expected = undefined;
    proposalId = undefined;
    // Pending approvals and paid model turns never replay after reopening.
    if (task && !task.dismissed && !terminal.has(task.phase) && !['verification-required', 'ready-to-review', 'revision-requested'].includes(task.phase)) {
      const run = currentRun();
      const stage = run?.state === 'running' ? run.stage : null;
      if (['cancelling', 'planning', 'proposing', 'reviewing', 'applying'].includes(task.phase)) {
        move('verification-required', 'The previous run stopped before its result was confirmed. No action will replay.',
          { interruptedStage: task.phase === 'applying' ? 'apply' : stage });
      } else {
        move('interrupted', 'The previous collaboration was interrupted. Start a new request after checking the file.');
      }
    }
  }
  restore();

  function requireIdleRoom() {
    if (closing || busy() || operation) throw invalid('Finish or cancel this collaboration before changing rooms or participants.');
  }

  function createRoom(name: string) {
    requireIdleRoom();
    journal.create(name);
    restore();
    return journal.list();
  }

  function openRoom(id: string) {
    if (journal.list().selectedRoomId === id && typeof id === 'string') return journal.list();
    requireIdleRoom();
    journal.select(id);
    restore();
    return journal.list();
  }

  function addParticipant(id: string, provider: CollaborationProvider) {
    requireIdleRoom();
    journal.addParticipant(id, provider);
    return journal.list();
  }

  async function status() {
    if (!operation && task && !task.dismissed && task.phase === 'awaiting-approval'
      && task.approvalExpiresAt !== undefined && now() >= task.approvalExpiresAt) {
      const expiring = task;
      await fileChange.discard();
      if (task === expiring) {
        proposalId = undefined;
        move('cancelled', 'The file approval expired. No change was applied for this attempt.');
      }
    }
    if (!operation && task && !task.dismissed && task.phase === 'verification-required') {
      const verifying = task;
      const run = currentRun();
      const confirmed = task.interruptedStage === 'codex'
        ? await verifyCodexTermination(run?.id, run?.commandId ?? run?.id)
        : (task.interruptedStage === 'plan' || task.interruptedStage === 'review') && (run?.pid === undefined || processIsGone(run.pid));
      if (confirmed && task === verifying && !operation) {
        const canReview = task.interruptedStage === 'review' && task.applied === true;
        move(canReview ? 'ready-to-review' : 'interrupted', canReview
          ? 'The interrupted review has stopped. Confirm to review the applied change again.'
          : 'The previous run has stopped. No action was replayed.',
        { interruptedStage: undefined, runs: updateRun({ state: 'interrupted', finishedAt: now() }) });
      }
    }
    return view();
  }

  async function prepare({ projectId, request, commandId, roomId }: Partial<CollaborationRequest> = {}) {
    if (closing || typeof commandId !== 'string' || !uuid.test(commandId) || typeof projectId !== 'string' || !validText(request, 3000)) {
      throw invalid('Select a registered project and enter a collaboration request of up to 3000 bytes.');
    }
    const { selectedRoomId, rooms } = journal.list();
    if (typeof roomId !== 'string' || roomId !== selectedRoomId) throw invalid('Open the room again before sending.');
    const members = rooms.find(room => room.id === roomId)?.participants;
    if (!members?.claude || !members.codex) throw invalid('Add Claude and Codex to this room first.');
    const participants = { claude: members.claude, codex: members.codex };
    if (task?.commandId === commandId) {
      if (task.requestHash !== version(JSON.stringify([projectId, request]))) throw invalid('This request ID was already used.');
      return view();
    }
    if (busy() || fileChange.isPending()) throw invalid('Finish or cancel the current file change or collaboration first.');
    preparing = true;
    try {
      const target = await selectFile();
      if (!target || closing) return null;
      expected = await inspect(projectId, target);
      if (closing) return null;
      const timestamp = now();
      save({
        id: randomUUID(), commandId, requestHash: version(JSON.stringify([projectId, request])),
        roomId, participants,
        projectId, target, fileName: path.basename(target), request, original: expected.file.text,
        fingerprint: fingerprint(expected), attempt: 1, revisionLimit: maxRevisions,
        phase: 'ready-to-plan', message: 'Review what will be sent to Claude.',
        createdAt: timestamp, updatedAt: timestamp, tests: [], runs: [], history: [], applied: false
      });
      return view();
    } finally { preparing = false; }
  }

  function runStage(stage: CollaborationRun['stage'], phase: CollaborationPhase, message: string,
    execute: (run: StoredRun, signal: AbortSignal, track: (fields: Partial<StoredRun>) => void) => Promise<StageOutcome>,
    { abortChild }: Pick<StageOperation, 'abortChild'> = {}) {
    const task = activeTask();
    const controller = new AbortController();
    const run: StoredRun = { id: randomUUID(), stage, attempt: task.attempt, state: 'running', startedAt: now() };
    move(phase, message, { runs: [...task.runs, run] });
    const active: StageOperation = { controller, abortChild };
    operation = active;
    active.promise = (async () => {
      try {
        const outcome = await execute(run, controller.signal, fields => set({ runs: updateRun(fields) }));
        if (active.cancellation) await active.cancellation;
        const cancelled = controller.signal.aborted && !outcome.applied;
        const result: StageOutcome = cancelled ? { ...outcome, phase: 'cancelled', message: 'Collaboration cancelled.' } : outcome;
        const { phase: next, message: statusMessage, ...changes } = result;
        move(next, statusMessage, {
          ...changes, runs: updateRun({
            state: next === 'cancelled' ? 'cancelled' : 'completed', finishedAt: now()
          })
        });
      } catch (error) {
        if (active.cancellation) {
          try { await active.cancellation; } catch (cancellationError) { error = cancellationError; }
        }
        const code = errorCode(error);
        const unverified = code === 'TERMINATION_UNVERIFIED' || code === 'CLAUDE_TERMINATION_UNVERIFIED';
        const cancelled = controller.signal.aborted;
        if (unverified || (stage === 'apply' && activeTask().applied !== true && active.writeAuthorized && !cancelled)) {
          move('verification-required', 'The result could not be confirmed. Check the file before starting another task.',
            { interruptedStage: stage, runs: updateRun({ errorCode: code ?? 'UNVERIFIED' }) });
        } else {
          move(cancelled ? 'cancelled' : 'failed', cancelled ? 'Collaboration cancelled.' : (error instanceof Error ? error.message : 'Collaboration failed.'),
            { runs: updateRun({ state: cancelled ? 'cancelled' : 'failed', finishedAt: now(), errorCode: code }) });
        }
      } finally {
        if (operation === active) operation = undefined;
      }
      return view();
    })();
    return active.promise;
  }

  function plan(id: string, attempt: number) {
    const task = expect(id, attempt, 'ready-to-plan');
    return runStage('plan', 'planning', 'Claude is planning…', async (run, signal, tracked) => {
      assertSource(await inspect(task.projectId, task.target));
      signal.throwIfAborted();
      const plan = await claude({ stage: 'plan', input: { request: task.request, fileName: task.fileName },
        signal, runId: run.id, onSpawn: pid => tracked({ pid }) });
      signal.throwIfAborted();
      if (!('instructions' in plan)) throw invalid('Claude did not return a plan.');
      return { phase: 'ready-to-propose', message: 'Confirm the assignment and selected file before sending to Codex.',
        plan, instructions: plan.instructions };
    });
  }

  function propose(id: string, attempt: number) {
    const task = expect(id, attempt, 'ready-to-propose');
    const plan = task.plan;
    if (!plan) throw invalid('No collaboration plan is available.');
    return runStage('codex', 'proposing', 'Codex is preparing a read-only proposal…', async (run, signal, tracked) => {
      const selection = await inspect(task.projectId, task.target);
      assertSource(selection);
      signal.throwIfAborted();
      const instructions = [task.instructions, '', 'Acceptance criteria:', ...plan.criteria.map(value => '- ' + value)].join('\n');
      const proposal = await fileChange.start({ projectId: task.projectId, instructions }, {
        target: task.target, expected, roomId: task.roomId, participantId: task.participants.codex, commandId: run.id,
        onRun: id => tracked({ id, commandId: run.id })
      });
      if (signal.aborted || !proposal) return { phase: 'cancelled', message: 'No file change was applied.' };
      proposalId = proposal.id;
      const { id: _, ...preview } = proposal;
      return { phase: 'awaiting-approval', message: 'Review the original and proposed replacement.',
        proposal: preview, approvalExpiresAt: now() + approvalLifetime };
    }, { abortChild: () => fileChange.discard() });
  }

  async function apply(id: string, attempt: number) {
    const task = expect(id, attempt, 'awaiting-approval');
    const { approvalExpiresAt, proposal } = task;
    const pendingId = proposalId;
    if (approvalExpiresAt === undefined || !proposal || !pendingId) throw invalid('This proposal is no longer available.');
    if (now() >= approvalExpiresAt) return status();
    return runStage('apply', 'applying', 'Confirm the file write in the approval dialog.', async (_run, signal, tracked) => {
      const applied = await fileChange.approve(pendingId, () => {
        signal.throwIfAborted();
        if (now() >= approvalExpiresAt) throw invalid('The file approval expired. No change was applied for this attempt.');
        tracked({ approvedAt: now() });
        if (operation) operation.writeAuthorized = true;
      });
      proposalId = undefined;
      if (!applied) return { phase: 'cancelled', message: 'The file approval was cancelled.' };
      return { phase: signal.aborted ? 'cancelled' : 'ready-to-review',
        message: signal.aborted ? 'The file was applied. Follow-up review was cancelled.' : 'The file was applied. Review what will be sent to Claude.',
        applied: true, appliedAt: now(), revision: version(proposal.replacement) };
    }, { abortChild: () => fileChange.discard() });
  }

  async function confirmAppliedRevision() {
    const task = activeTask();
    const selection = await inspect(task.projectId, task.target);
    if (selection.workspace.fileId !== task.fingerprint.workspaceId || version(selection.file.text) !== task.revision) {
      throw invalid('The applied file has changed since approval. Start a new collaboration with the current file.');
    }
    return selection;
  }

  function review(id: string, attempt: number) {
    const task = expect(id, attempt, 'ready-to-review');
    const { plan, proposal } = task;
    if (!plan || !proposal) throw invalid('The approved change is unavailable.');
    return runStage('review', 'reviewing', 'Claude is reviewing the applied change…', async (run, signal, tracked) => {
      await confirmAppliedRevision();
      signal.throwIfAborted();
      const review = await claude({ stage: 'review', input: {
        plan: { summary: plan.summary, criteria: plan.criteria }, fileName: task.fileName, original: proposal.original,
        replacement: proposal.replacement, tests: activeTask().tests
      }, signal, runId: run.id, onSpawn: pid => tracked({ pid }) });
      signal.throwIfAborted();
      await confirmAppliedRevision();
      signal.throwIfAborted();
      if (!('verdict' in review)) throw invalid('Claude did not return a review.');
      if (review.verdict === 'revision') {
        const canRevise = task.attempt <= maxRevisions;
        return { phase: canRevise ? 'revision-requested' : 'revision-limit', review,
          message: canRevise ? 'Claude requested a revision. Confirm before sending it to Codex.' : 'The revision limit was reached.' };
      }
      return { phase: review.verdict === 'passed' ? 'completed' : 'failed', review,
        message: review.verdict === 'passed' ? 'Claude review passed.' : 'Claude review did not pass.' };
    });
  }

  async function recordTest(input: RecordTestRequest) {
    const { id, attempt, command, actor, exitCode, result, revision } = input ?? {};
    const task = expect(id, attempt, 'ready-to-review');
    if (!validText(command, 512) || !validText(actor, 120) || !validText(result, 768) ||
        typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255 || typeof revision !== 'string' || revision !== task.revision || task.tests.length >= 4) {
      throw invalid('Enter a test command, who ran it, its exit code and result for the applied revision.');
    }
    await confirmAppliedRevision();
    const latest = expect(id, attempt, 'ready-to-review');
    if (latest.tests.length >= 4) throw invalid('The test record limit was reached.');
    set({ tests: [...latest.tests, { command, actor, exitCode, result, revision }] });
    return view();
  }

  async function revise(id: string, attempt: number) {
    expect(id, attempt, 'revision-requested');
    const current = await confirmAppliedRevision();
    const task = expect(id, attempt, 'revision-requested');
    const { proposal, review, tests, revision, appliedAt } = task;
    if (!proposal || !review || revision === undefined || appliedAt === undefined) throw invalid('The previous revision is unavailable.');
    expected = current;
    move('ready-to-propose', 'Review the revision assignment before sending to Codex.', {
      attempt: task.attempt + 1, instructions: review.summary, original: current.file.text,
      fingerprint: fingerprint(current), history: [...task.history, { proposal, review, tests, revision, appliedAt }],
      proposal: undefined, review: undefined, approvalExpiresAt: undefined, tests: [], applied: false, revision: undefined, appliedAt: undefined
    });
    return view();
  }

  async function cancel(id: string, attempt: number) {
    const current = requireTask(id, attempt);
    if (terminal.has(current.phase) || current.phase === 'verification-required') return view();
    const active = operation;
    if (active) {
      if (!active.controller.signal.aborted) {
        move('cancelling', 'Waiting for the active operation to stop…');
        active.controller.abort();
        active.cancellation = Promise.resolve().then(() => active.abortChild?.()).catch(error => {
          throw Object.assign(new Error(error instanceof Error ? error.message : 'Cancellation failed.'), { code: 'TERMINATION_UNVERIFIED' });
        });
        // Stage finalization waits for child cancellation before releasing the room.
        await active.cancellation.catch(() => {});
      }
      return await active.promise ?? view();
    }
    if (pendingApprovalPhases.has(current.phase)) {
      await fileChange.discard();
      if (task?.id !== id || task.attempt !== attempt) return null;
      proposalId = undefined;
    }
    const latest = activeTask();
    if (!terminal.has(latest.phase) && !operation) move('cancelled', latest.applied
      ? 'The file was applied. Follow-up review was cancelled.' : 'Collaboration cancelled.');
    return view();
  }

  async function dismiss(id: string, attempt: number) {
    const task = requireTask(id, attempt);
    // An uncertain write requires an explicit acknowledgement after checking the file.
    if (busy() && !(task.phase === 'verification-required' && task.interruptedStage === 'apply')) {
      throw invalid('Finish or cancel this collaboration before clearing it.');
    }
    const { roomId, commandId, requestHash, phase } = task;
    save({ id, roomId, attempt, commandId, requestHash, phase: terminal.has(phase) ? phase : 'interrupted',
      dismissed: true, updatedAt: now() });
    return null;
  }

  async function close(): Promise<void> {
    if (closing) { await operation?.promise; return; }
    const cancellation = busy() && task && task.phase !== 'verification-required' ? cancel(task.id, task.attempt) : null;
    closing = true;
    await cancellation;
  }
  return { listRooms: journal.list, createRoom, openRoom, addParticipant, prepare, status, plan, propose, apply, review, revise, cancel, recordTest, dismiss, busy, close };
}
