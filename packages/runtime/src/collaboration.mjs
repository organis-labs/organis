import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const terminal = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'revision-limit']);
const approvalLifetime = 10 * 60 * 1000;
const maxRevisions = 1;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid = message => new Error(message);
const version = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const pendingApprovalPhases = new Set(['awaiting-approval', 'applying']);

function validText(value, limit) {
  return typeof value === 'string' && value.trim() && value.isWellFormed() &&
    !value.includes('\0') && Buffer.byteLength(value) <= limit;
}

function processIsGone(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export function openCollaborationJournal(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'collaboration.json');
  return {
    read() {
      try {
        const record = JSON.parse(readFileSync(target, 'utf8'));
        if (record.schema !== 1 || !uuid.test(record.task?.id) || typeof record.task.phase !== 'string') {
          throw invalid('Unsupported collaboration journal.');
        }
        return record.task;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    write(task) {
      const temp = path.join(directory, `collaboration-${randomUUID()}.next`);
      const file = openSync(temp, 'wx', 0o600);
      try {
        try {
          writeFileSync(file, JSON.stringify({ schema: 1, task }), 'utf8');
          fsyncSync(file);
        } finally { closeSync(file); }
        renameSync(temp, target);
      } finally { rmSync(temp, { force: true }); }
    }
  };
}

export function createCollaboration({
  journal, selectFile, inspect, claude, fileChange, verifyCodexTermination, now = Date.now
}) {
  let task = journal.read();
  let preparing = false;
  let operation;
  let expected;
  let proposalId;
  let closing = false;

  function save(next) {
    journal.write(next);
    task = next;
  }
  function set(changes) { save({ ...task, ...changes, updatedAt: now() }); }
  /** @returns {import('./collaboration-types.mjs').CollaborationSnapshot | null} */
  function view() {
    if (!task || task.dismissed) return null;
    const { commandId, requestHash, fingerprint, interruptedStage, runs, ...snapshot } = task;
    return structuredClone({ ...snapshot, runs: runs.map(({ pid, ...run }) => run),
      canAcknowledgeUncertainWrite: snapshot.phase === 'verification-required' && interruptedStage === 'apply' });
  }
  function move(phase, message, changes = {}) { set({ ...changes, phase, message }); }
  function busy() { return preparing || Boolean(task && !terminal.has(task.phase)); }
  function requireTask(id, attempt) {
    if (closing || !task || task.dismissed || task.id !== id || task.attempt !== attempt) {
      throw invalid('This collaboration attempt is no longer available.');
    }
  }
  function expect(id, attempt, phase) {
    requireTask(id, attempt);
    if (operation || task.phase !== phase) throw invalid('This action is unavailable in the current phase.');
  }
  function currentRun() { return task.runs.at(-1); }
  function updateRun(fields) {
    return [...task.runs.slice(0, -1), { ...currentRun(), ...fields }];
  }
  function fingerprint(selection) {
    return { workspaceId: selection.workspace.fileId, identity: selection.file.identity, revision: version(selection.file.text) };
  }
  function assertSource(selection) {
    const current = fingerprint(selection);
    if (Object.keys(current).some(key => current[key] !== task.fingerprint[key])) {
      throw invalid('The selected file changed. Start a new collaboration with the current file.');
    }
  }

  // The previous owner never grants approval or resumes a paid model turn after a restart.
  if (task && !terminal.has(task.phase) && !['verification-required', 'ready-to-review', 'revision-requested'].includes(task.phase)) {
    const stage = currentRun()?.state === 'running' ? currentRun().stage : null;
    if (['cancelling', 'planning', 'proposing', 'reviewing', 'applying'].includes(task.phase)) {
      move('verification-required', 'The previous run stopped before its result was confirmed. No action will replay.',
        { interruptedStage: task.phase === 'applying' ? 'apply' : stage });
    } else {
      move('interrupted', 'The previous collaboration was interrupted. Start a new request after checking the file.');
    }
  }

  async function status() {
    if (!operation && task?.phase === 'awaiting-approval' && now() >= task.approvalExpiresAt) {
      await fileChange.discard();
      proposalId = undefined;
      if (task.phase === 'awaiting-approval') move('cancelled', 'The file approval expired. No change was applied for this attempt.');
    }
    if (!operation && task?.phase === 'verification-required') {
      const run = currentRun();
      const confirmed = task.interruptedStage === 'codex'
        ? await verifyCodexTermination(run?.id, run?.commandId ?? run?.id)
        : ['plan', 'review'].includes(task.interruptedStage) && (run?.pid === undefined || processIsGone(run.pid));
      if (confirmed && task.phase === 'verification-required' && !operation) {
        const canReview = task.interruptedStage === 'review' && task.applied === true;
        move(canReview ? 'ready-to-review' : 'interrupted', canReview
          ? 'The interrupted review has stopped. Confirm to review the applied change again.'
          : 'The previous run has stopped. No action was replayed.',
        { interruptedStage: undefined, runs: updateRun({ state: 'interrupted', finishedAt: now() }) });
      }
    }
    return view();
  }

  /** @param {import('./collaboration-types.mjs').CollaborationRequest} input */
  async function prepare({ projectId, request, commandId } = {}) {
    if (closing || !uuid.test(commandId ?? '') || typeof projectId !== 'string' || !validText(request, 3000)) {
      throw invalid('Select a registered project and enter a collaboration request of up to 3000 bytes.');
    }
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
        roomId: randomUUID(), participants: { claude: randomUUID(), codex: randomUUID() },
        projectId, target, fileName: path.basename(target), request, original: expected.file.text,
        fingerprint: fingerprint(expected), attempt: 1, revisionLimit: maxRevisions,
        phase: 'ready-to-plan', message: 'Review what will be sent to Claude.',
        createdAt: timestamp, updatedAt: timestamp, tests: [], runs: [], history: [], applied: false
      });
      return view();
    } finally { preparing = false; }
  }

  function runStage(stage, phase, message, execute, { abortChild } = {}) {
    const controller = new AbortController();
    const run = { id: randomUUID(), stage, attempt: task.attempt, state: 'running', startedAt: now() };
    move(phase, message, { runs: [...task.runs, run] });
    const active = { controller, abortChild, stage, promise: null, cancellation: null };
    operation = active;
    active.promise = (async () => {
      try {
        const outcome = await execute(run, controller.signal, fields => set({ runs: updateRun(fields) }));
        if (active.cancellation) await active.cancellation;
        const cancelled = controller.signal.aborted && !outcome.applied;
        const result = cancelled ? { ...outcome, phase: 'cancelled', message: 'Collaboration cancelled.' } : outcome;
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
        const unverified = ['TERMINATION_UNVERIFIED', 'CLAUDE_TERMINATION_UNVERIFIED'].includes(error.code);
        const cancelled = controller.signal.aborted;
        if (unverified || (stage === 'apply' && task.applied !== true && active.writeAuthorized && !cancelled)) {
          move('verification-required', 'The result could not be confirmed. Check the file before starting another task.',
            { interruptedStage: stage, runs: updateRun({ errorCode: error.code ?? 'UNVERIFIED' }) });
        } else {
          move(cancelled ? 'cancelled' : 'failed', cancelled ? 'Collaboration cancelled.' : error.message,
            { runs: updateRun({ state: cancelled ? 'cancelled' : 'failed', finishedAt: now(), errorCode: error.code }) });
        }
      } finally {
        if (operation === active) operation = undefined;
      }
      return view();
    })();
    return active.promise;
  }

  function plan(id, attempt) {
    expect(id, attempt, 'ready-to-plan');
    return runStage('plan', 'planning', 'Claude is planning…', async (run, signal, tracked) => {
      assertSource(await inspect(task.projectId, task.target));
      signal.throwIfAborted();
      const plan = await claude({ stage: 'plan', input: { request: task.request, fileName: task.fileName },
        signal, runId: run.id, onSpawn: pid => tracked({ pid }) });
      signal.throwIfAborted();
      return { phase: 'ready-to-propose', message: 'Confirm the assignment and selected file before sending to Codex.',
        plan, instructions: plan.instructions };
    });
  }

  function propose(id, attempt) {
    expect(id, attempt, 'ready-to-propose');
    return runStage('codex', 'proposing', 'Codex is preparing a read-only proposal…', async (run, signal, tracked) => {
      const selection = await inspect(task.projectId, task.target);
      assertSource(selection);
      signal.throwIfAborted();
      const instructions = [task.instructions, '', 'Acceptance criteria:', ...task.plan.criteria.map(value => '- ' + value)].join('\n');
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

  async function apply(id, attempt) {
    expect(id, attempt, 'awaiting-approval');
    if (now() >= task.approvalExpiresAt) return status();
    return runStage('apply', 'applying', 'Confirm the file write in the approval dialog.', async (_run, signal, tracked) => {
      const applied = await fileChange.approve(proposalId, () => {
        signal.throwIfAborted();
        if (now() >= task.approvalExpiresAt) throw invalid('The file approval expired. No change was applied for this attempt.');
        tracked({ approvedAt: now() });
        operation.writeAuthorized = true;
      });
      proposalId = undefined;
      if (!applied) return { phase: 'cancelled', message: 'The file approval was cancelled.' };
      return { phase: signal.aborted ? 'cancelled' : 'ready-to-review',
        message: signal.aborted ? 'The file was applied. Follow-up review was cancelled.' : 'The file was applied. Review what will be sent to Claude.',
        applied: true, appliedAt: now(), revision: version(task.proposal.replacement) };
    }, { abortChild: () => fileChange.discard() });
  }

  async function confirmAppliedRevision() {
    const selection = await inspect(task.projectId, task.target);
    if (selection.workspace.fileId !== task.fingerprint.workspaceId || version(selection.file.text) !== task.revision) {
      throw invalid('The applied file has changed since approval. Start a new collaboration with the current file.');
    }
    return selection;
  }

  function review(id, attempt) {
    expect(id, attempt, 'ready-to-review');
    return runStage('review', 'reviewing', 'Claude is reviewing the applied change…', async (run, signal, tracked) => {
      await confirmAppliedRevision();
      signal.throwIfAborted();
      const review = await claude({ stage: 'review', input: {
        plan: { summary: task.plan.summary, criteria: task.plan.criteria }, fileName: task.fileName, original: task.proposal.original,
        replacement: task.proposal.replacement, tests: task.tests
      }, signal, runId: run.id, onSpawn: pid => tracked({ pid }) });
      signal.throwIfAborted();
      await confirmAppliedRevision();
      signal.throwIfAborted();
      if (review.verdict === 'revision') {
        const canRevise = task.attempt <= maxRevisions;
        return { phase: canRevise ? 'revision-requested' : 'revision-limit', review,
          message: canRevise ? 'Claude requested a revision. Confirm before sending it to Codex.' : 'The revision limit was reached.' };
      }
      return { phase: review.verdict === 'passed' ? 'completed' : 'failed', review,
        message: review.verdict === 'passed' ? 'Claude review passed.' : 'Claude review did not pass.' };
    });
  }

  /** @param {import('./collaboration-types.mjs').RecordTestRequest} input */
  async function recordTest({ id, attempt, command, actor, exitCode, result, revision } = {}) {
    expect(id, attempt, 'ready-to-review');
    if (!validText(command, 512) || !validText(actor, 120) || !validText(result, 768) ||
        !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255 || revision !== task.revision || task.tests.length >= 4) {
      throw invalid('Enter a test command, who ran it, its exit code and result for the applied revision.');
    }
    await confirmAppliedRevision();
    expect(id, attempt, 'ready-to-review');
    if (task.tests.length >= 4) throw invalid('The test record limit was reached.');
    set({ tests: [...task.tests, { command, actor, exitCode, result, revision }] });
    return view();
  }

  async function revise(id, attempt) {
    expect(id, attempt, 'revision-requested');
    const current = await confirmAppliedRevision();
    expect(id, attempt, 'revision-requested');
    expected = current;
    const { proposal, review, tests, revision, appliedAt } = task;
    move('ready-to-propose', 'Review the revision assignment before sending to Codex.', {
      attempt: task.attempt + 1, instructions: review.summary, original: current.file.text,
      fingerprint: fingerprint(current), history: [...task.history, { proposal, review, tests, revision, appliedAt }],
      proposal: undefined, review: undefined, approvalExpiresAt: undefined, tests: [], applied: false, revision: undefined, appliedAt: undefined
    });
    return view();
  }

  async function cancel(id, attempt) {
    requireTask(id, attempt);
    if (terminal.has(task.phase) || task.phase === 'verification-required') return view();
    const active = operation;
    if (active) {
      if (!active.controller.signal.aborted) {
        move('cancelling', 'Waiting for the active operation to stop…');
        active.controller.abort();
        active.cancellation = Promise.resolve().then(() => active.abortChild?.()).catch(error => {
          throw Object.assign(new Error(error.message), { code: 'TERMINATION_UNVERIFIED' });
        });
        // Stage finalization waits for child cancellation before releasing the room.
        await active.cancellation.catch(() => {});
      }
      return active.promise;
    }
    if (pendingApprovalPhases.has(task.phase)) {
      await fileChange.discard();
      proposalId = undefined;
    }
    if (!terminal.has(task.phase) && !operation) move('cancelled', task.applied
      ? 'The file was applied. Follow-up review was cancelled.' : 'Collaboration cancelled.');
    return view();
  }

  async function dismiss(id, attempt) {
    requireTask(id, attempt);
    // An uncertain write requires an explicit acknowledgement after checking the file.
    if (busy() && !(task.phase === 'verification-required' && task.interruptedStage === 'apply')) {
      throw invalid('Finish or cancel this collaboration before clearing it.');
    }
    const { commandId, requestHash, phase } = task;
    save({ id, attempt, commandId, requestHash, phase: terminal.has(phase) ? phase : 'interrupted',
      dismissed: true, updatedAt: now() });
    return null;
  }

  async function close() {
    if (closing) return operation?.promise;
    const cancellation = busy() && task && task.phase !== 'verification-required' ? cancel(task.id, task.attempt) : null;
    closing = true;
    await cancellation;
  }
  return { prepare, status, plan, propose, apply, review, revise, cancel, recordTest, dismiss, busy, close };
}
