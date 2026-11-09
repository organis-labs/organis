import { LocalRuntime } from '../../../packages/runtime/src/execution.mjs';
import { resolve } from 'node:path';

const usageError = message => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
const valueOptions = new Set(['workspace', 'state-dir', 'command-id', 'mode', 'duration', 'scope', 'after']);

export async function executionCommand(args) {
  const command = args.shift();
  const id = ['show', 'events', 'cancel'].includes(command) ? args.shift() : undefined;
  const allowed = {
    fixture: ['workspace', 'state-dir', 'command-id', 'mode', 'duration', 'scope', 'json'],
    list: ['state-dir', 'json'], show: ['state-dir', 'json'],
    events: ['state-dir', 'after', 'json'], cancel: ['state-dir', 'command-id', 'json'],
    reconcile: ['state-dir', 'json']
  }[command];
  if (!allowed || (['show', 'events', 'cancel'].includes(command) && (!id || id.startsWith('--')))) {
    throw usageError('Use run fixture|list|show <id>|events <id>|cancel <id>|reconcile.');
  }
  const options = {};
  while (args.length) {
    const flag = args.shift();
    const key = flag.startsWith('--') ? flag.slice(2) : '';
    if (!allowed.includes(key) || Object.hasOwn(options, key)) throw usageError(`Unexpected option: ${flag}`);
    if (!valueOptions.has(key)) { options[key] = true; continue; }
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw usageError(`Missing value for ${flag}`);
    options[key] = value;
  }
  if (command === 'fixture' && !options.workspace) throw usageError('--workspace is required.');
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
  const stopObserving = () => {
    try { print('observation-stopped', { run: runtime.getRun(activeId), message: 'Observation stopped; this is not confirmation of termination. Inspect and reconcile the saved run.' }); }
    finally { process.exit(130); }
  };
  const interrupt = () => {
    if (activeId && (!ownsRun || interrupted)) return stopObserving();
    interrupted = true;
    if (activeId) runtime.cancel(activeId).catch(() => { process.exitCode = 1; });
  };
  const parentControl = message => { if (message?.type === 'organis:interrupt') interrupt(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.on('message', parentControl);
  process.on('disconnect', interrupt);
  try {
    if (command === 'fixture') {
      const accepted = await runtime.startFixture({
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
      const run = await runtime.wait(activeId);
      print('result', { run });
      process.exitCode = run.state === 'completed' ? 0 : run.state === 'cancelled' ? 130 : 1;
    } else if (command === 'list') print('runs', { runs: runtime.listRuns() });
    else if (command === 'show') print('run', { run: runtime.getRun(id) });
    else if (command === 'events') print('events', { events: runtime.events(id, Number(options.after ?? 0)) });
    else if (command === 'cancel') print('cancel-requested', { run: await runtime.cancel(id, { commandId: options['command-id'] }) });
    else print('reconciled', { runs: await runtime.reconcile() });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    process.off('message', parentControl);
    process.off('disconnect', interrupt);
    await runtime.close();
    if (process.connected) process.disconnect();
  }
}
