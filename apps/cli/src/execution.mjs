import { LocalRuntime } from '../../../packages/runtime/src/execution.mjs';
import { resolve } from 'node:path';

const usageError = message => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
const valueOptions = new Set(['workspace', 'state-dir', 'command-id', 'mode', 'duration', 'scope', 'after', 'prompt', 'executable']);

export async function executionCommand(args) {
  const command = args.shift();
  const needsId = ['codex', 'show', 'events', 'cancel', 'deny'].includes(command);
  const id = needsId ? args.shift() : undefined;
  const approvalId = command === 'deny' ? args.shift() : undefined;
  const allowed = {
    fixture: ['workspace', 'state-dir', 'command-id', 'mode', 'duration', 'scope', 'json'],
    codex: ['prompt', 'executable', 'state-dir', 'command-id', 'show-approval', 'json'],
    list: ['state-dir', 'json'], show: ['state-dir', 'json'],
    events: ['state-dir', 'after', 'json'], cancel: ['state-dir', 'command-id', 'json'],
    deny: ['state-dir', 'json'],
    reconcile: ['state-dir', 'json']
  }[command];
  if (!Array.isArray(allowed) || (needsId && (!id || id.startsWith('--')))) {
    throw usageError('Use run codex <project-id>|fixture|list|show <id>|events <id>|cancel <id>|deny <id> <approval-id>|reconcile.');
  }
  if (command === 'deny' && (!approvalId || approvalId.startsWith('--'))) throw usageError('An approval ID is required.');
  const options = {};
  while (args.length) {
    const flag = args.shift();
    const inlinePrompt = flag.startsWith('--prompt=');
    const key = inlinePrompt ? 'prompt' : flag.startsWith('--') ? flag.slice(2) : '';
    if (!allowed.includes(key) || Object.hasOwn(options, key)) throw usageError(`Unexpected option: ${flag}`);
    if (!valueOptions.has(key)) { options[key] = true; continue; }
    const value = inlinePrompt ? flag.slice('--prompt='.length) : args.shift();
    if (value === undefined || (!inlinePrompt && value.startsWith('--'))) throw usageError(`Missing value for ${flag}`);
    options[key] = value;
  }
  if (command === 'fixture' && !options.workspace) throw usageError('--workspace is required.');
  if (command === 'codex' && !options.prompt?.trim()) throw usageError('--prompt is required.');
  for (const key of ['duration', 'after']) {
    if (options[key] !== undefined && (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key])))) {
      throw usageError(`--${key} must be a nonnegative safe integer.`);
    }
  }
  const runtime = new LocalRuntime({ stateDir: options['state-dir'] });
  const print = (type, value) => console.log(options.json ? JSON.stringify({ type, ...value }) : JSON.stringify(value, null, 2));
  let activeId;
  let interrupted = false;
  let ownsRun = false;
  let approvalTimer;
  let shownApprovalId;
  const stopObserving = () => {
    try { print('observation-stopped', { run: runtime.getRun(activeId), message: 'Observation stopped; this is not confirmation of termination. Inspect and reconcile the saved run.' }); }
    finally { process.exit(130); }
  };
  const interrupt = () => {
    if (activeId && (!ownsRun || interrupted)) return stopObserving();
    interrupted = true;
    if (activeId) runtime.cancel(activeId).catch(error => {
      const code = error.code ?? 'RUNTIME_ERROR';
      const message = `Cancellation request failed: ${error.message}. Press Ctrl+C again to stop observing; termination is not confirmed. Inspect and reconcile the saved run.`;
      console.error(options.json ? JSON.stringify({ type: 'error', code, message }) : `${code}: ${message}`);
    });
  };
  const parentControl = message => { if (message?.type === 'organis:interrupt') interrupt(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.on('message', parentControl);
  process.on('disconnect', interrupt);
  if (process.connected) process.send({ type: 'organis:control-ready' }, () => {});
  try {
    if (command === 'fixture' || command === 'codex') {
      const accepted = command === 'codex' ? await runtime.startCodex({
        projectId: id, prompt: options.prompt, executable: options.executable, commandId: options['command-id'], profile: 'cli'
      }) : await runtime.startFixture({
        workspace: resolve(options.workspace), commandId: options['command-id'],
        mode: options.mode ?? 'complete', durationMs: options.duration === undefined ? 250 : Number(options.duration),
        scope: options.scope ?? 'trusted-workspace'
      });
      activeId = accepted.run.id;
      ownsRun = !accepted.duplicate;
      print('accepted', accepted);
      if (interrupted) {
        if (!ownsRun) stopObserving();
        await runtime.cancel(activeId);
      }
      if (command === 'codex' && options['show-approval'] && ownsRun) {
        approvalTimer = setInterval(() => {
          let approval;
          try { approval = runtime.pendingApproval(activeId); }
          catch { return; } // A busy state store is retried on the next observation.
          if (!approval || approval.approvalId === shownApprovalId) return;
          shownApprovalId = approval.approvalId;
          print('approval-requested', { runId: activeId, approval });
        }, 250);
      }
      const run = await runtime.wait(activeId);
      if (run.mode === 'codex-read-only' && run.state === 'completed') {
        const answer = runtime.events(activeId).find(event => event.type === 'codex_answer')?.text;
        print('result', { run, answer: answer ?? null });
      } else print('result', { run });
      process.exitCode = run.state === 'completed' ? 0 : run.state === 'cancelled' ? 130 : 1;
    } else if (command === 'list') print('runs', { runs: runtime.listRuns() });
    else if (command === 'show') print('run', { run: runtime.getRun(id) });
    else if (command === 'events') print('events', { events: runtime.events(id, Number(options.after ?? 0)) });
    else if (command === 'cancel') print('cancel-requested', { run: await runtime.cancel(id, { commandId: options['command-id'] }) });
    else if (command === 'deny') print('approval-denied', { approvalId, run: runtime.denyApproval(id, approvalId) });
    else print('reconciled', { runs: await runtime.reconcile() });
  } finally {
    clearInterval(approvalTimer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    process.off('message', parentControl);
    process.off('disconnect', interrupt);
    await runtime.close();
    if (process.connected) process.disconnect();
  }
}
