import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  APPROVAL_STATES, ERROR_CODES, ENTITY_CONTRACTS, FIXTURE_CAPABILITY, LIVE_STATES, LocalRuntime, RUN_STATES,
  RuntimeError, TERMINAL_STATES, TRANSITIONS, defaultStateDir
} from '../packages/runtime/src/execution.mjs';
import {
  APPROVAL_IDENTITY_CONTRACT, IMPLEMENTED_STATES, SCHEMA_VERSION, assertTransition
} from '../packages/runtime/src/contracts.mjs';
import { pidAlive } from '../packages/runtime/src/process-tree.mjs';

const EXECUTION_URL = pathToFileURL(path.resolve(import.meta.dirname, '../packages/runtime/src/execution.mjs')).href;
const OPTIONS = { timeout: 30000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 10000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(intervalMs);
  }
}

// Cleanup stack: runs in reverse order so runtimes close before their directories are removed.
function harness(t) {
  const stack = [];
  t.after(async () => {
    for (const fn of stack.reverse()) {
      try { await fn(); } catch { /* best effort */ }
    }
  });
  const dir = prefix => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    stack.push(() => fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    return target;
  };
  const runtime = (stateDir, options) => {
    const instance = new LocalRuntime({ stateDir, ...options });
    stack.push(() => instance.close());
    return instance;
  };
  const helper = (code, params) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(params)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const messages = [];
    const waiters = [];
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) waiter(message); else messages.push(message);
      }
    });
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    stack.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    return {
      child, exited, stderr: () => stderr,
      next: (timeoutMs = 20000) => new Promise((resolve, reject) => {
        if (messages.length) return resolve(messages.shift());
        const timer = setTimeout(() => reject(new Error(`helper timeout; stderr=${stderr}`)), timeoutMs);
        waiters.push(message => { clearTimeout(timer); resolve(message); });
      }),
      stop: () => { try { child.stdin.write('stop\n'); } catch { /* helper already gone */ } }
    };
  };
  return { dir, runtime, helper, push: fn => stack.push(fn) };
}

const HELPER = `
const p = JSON.parse(process.argv[1]);
const { LocalRuntime } = await import(p.url);
const say = value => new Promise(resolve => process.stdout.write(JSON.stringify(value) + '\\n', resolve));
const rt = new LocalRuntime({ stateDir: p.stateDir });
for (;;) {
  const remaining = p.barrier - Date.now();
  if (remaining <= 0) break;
  if (remaining > 25) await new Promise(resolve => setTimeout(resolve, 5));
}
let out;
try {
  const r = await rt.startFixture({ workspace: p.workspace, commandId: p.commandId, mode: p.mode, durationMs: p.durationMs });
  out = { ok: true, runId: r.run.id, duplicate: r.duplicate, pid: process.pid };
} catch (error) {
  out = { ok: false, code: error.code, message: error.message, pid: process.pid };
}
await say(out);
if (out.ok) {
  if (p.mode === 'wait') {
    await new Promise(resolve => { process.stdin.once('data', resolve); process.stdin.once('end', resolve); });
    await rt.cancel(out.runId).catch(() => {});
  }
  const final = await rt.wait(out.runId, { timeoutMs: 20000 }).catch(error => ({ state: 'error:' + error.code }));
  await say({ final: final.state });
}
await rt.close();
process.exit(0);
`;

const helperParams = (stateDir, workspace, extra = {}) => ({
  url: EXECUTION_URL, stateDir, workspace, mode: 'complete', durationMs: 300, barrier: 0, ...extra
});

const readyEvent = (runtime, id) => runtime.events(id).find(event => event.type === 'fixture_ready');
const waitReady = (runtime, id) => waitFor(() => readyEvent(runtime, id), { label: 'fixture_ready' });
const terminalOf = async (runtime, id) => runtime.wait(id, { timeoutMs: 20000 });

async function pidsDead(...pids) {
  await waitFor(() => pids.every(pid => !pidAlive(pid)), { timeoutMs: 10000, label: 'pids to exit' });
}

test('a. fixture completes and fails with ordered events', OPTIONS, async t => {
  const h = harness(t);
  const rt = h.runtime(h.dir('organis-rt-'));
  const ws = h.dir('organis-rt-');
  const { run, duplicate } = await rt.startFixture({ workspace: ws });
  assert.equal(duplicate, false);
  assert.equal(run.state, 'queued');
  assert.equal(run.approvalState, 'not_required');
  const done = await rt.wait(run.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.exitCode, 0);
  assert.equal(done.errorCode, null);
  assert.equal(done.ownershipRetained, false);
  const events = rt.events(run.id);
  const sequences = events.map(event => event.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.equal(new Set(sequences).size, sequences.length);
  const types = events.map(event => event.type);
  assert.equal(readyEvent(rt, run.id).cwd, fs.realpathSync.native(ws));
  for (const type of ['run_created', 'process_started', 'fixture_ready', 'completed']) assert.ok(types.includes(type), type);
  assert.deepEqual(rt.events(run.id, sequences[1]).map(event => event.sequence), sequences.slice(2));
  assert.deepEqual(rt.events(run.id, sequences.at(-1)), []);
  assert.equal(rt.getRun(run.id).state, 'completed');
  assert.equal(rt.listRuns()[0].id, run.id);

  const failed = await rt.startFixture({ workspace: ws, mode: 'fail', durationMs: 50 });
  const result = await rt.wait(failed.run.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.errorCode, 'FIXTURE_FAILED');
  assert.equal(rt.events(failed.run.id).at(-1).type, 'failed');
  assert.equal(rt.listRuns()[0].id, failed.run.id);
  await assert.rejects(rt.wait(randomId()), { code: 'RUN_NOT_FOUND' });
  assert.throws(() => rt.events(randomId()), { code: 'RUN_NOT_FOUND' });
  assert.throws(() => rt.getRun(randomId()), { code: 'RUN_NOT_FOUND' });
});

function randomId() { return crypto.randomUUID(); }

test('b. invalid requests fail before any run exists', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const rt = h.runtime(stateDir);
  const ws = h.dir('organis-rt-');
  const file = path.join(ws, 'file.txt');
  fs.writeFileSync(file, 'synthetic');
  const sub = path.join(stateDir, 'sub');
  fs.mkdirSync(sub);
  const dottedSub = path.join(stateDir, '..still-inside');
  fs.mkdirSync(dottedSub);
  const reject = (options, code) => assert.rejects(rt.startFixture(options), { code });
  await reject({ workspace: path.join(ws, 'missing') }, 'INVALID_WORKSPACE');
  await reject({ workspace: file }, 'INVALID_WORKSPACE');
  await reject({ workspace: 'relative/dir' }, 'INVALID_WORKSPACE');
  await reject({}, 'INVALID_WORKSPACE');
  await reject({ workspace: ws, scope: 'sandbox' }, 'SANDBOX_UNSUPPORTED');
  await reject({ workspace: ws, sandbox: true }, 'SANDBOX_UNSUPPORTED');
  await reject({ workspace: ws, network: 'deny' }, 'SANDBOX_UNSUPPORTED');
  await reject({ workspace: ws, scope: 'admin' }, 'SCOPE_DENIED');
  await reject({ workspace: os.homedir() }, 'SCOPE_DENIED');
  await reject({ workspace: path.parse(os.tmpdir()).root }, 'SCOPE_DENIED');
  await reject({ workspace: stateDir }, 'SCOPE_DENIED');
  await reject({ workspace: sub }, 'SCOPE_DENIED');
  await reject({ workspace: dottedSub }, 'SCOPE_DENIED');
  await reject({ workspace: path.dirname(stateDir) }, 'SCOPE_DENIED');
  for (const extra of [{ command: 'calc.exe' }, { executable: 'x' }, { args: [] }, { env: {} }, { shell: true }, { cwd: ws }]) {
    await reject({ workspace: ws, ...extra }, 'INVALID_ARGUMENT');
  }
  await reject({ workspace: ws, mode: 'run' }, 'INVALID_ARGUMENT');
  await reject({ workspace: ws, durationMs: -1 }, 'INVALID_ARGUMENT');
  await reject({ workspace: ws, durationMs: 30001 }, 'INVALID_ARGUMENT');
  await reject({ workspace: ws, durationMs: 1.5 }, 'INVALID_ARGUMENT');
  await reject({ workspace: ws, commandId: 'not-a-uuid' }, 'INVALID_ARGUMENT');
  await reject({ workspace: ws, roomId: 'room' }, 'INVALID_ARGUMENT');
  await reject({ workspace: ws, participantId: 7 }, 'INVALID_ARGUMENT');
  assert.deepEqual(rt.listRuns(), []);
  const db = new DatabaseSync(path.join(stateDir, 'runtime.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  db.close();
});

test('c. commandId is an idempotency key', OPTIONS, async t => {
  const h = harness(t);
  const rt = h.runtime(h.dir('organis-rt-'));
  const ws = h.dir('organis-rt-');
  const commandId = randomId();
  const first = await rt.startFixture({ workspace: ws, commandId, durationMs: 100 });
  const again = await rt.startFixture({ workspace: ws, commandId, durationMs: 100 });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.run.id, first.run.id);
  assert.equal(rt.listRuns().length, 1);
  await assert.rejects(rt.startFixture({ workspace: ws, commandId, durationMs: 100, mode: 'fail' }), { code: 'COMMAND_CONFLICT' });
  await assert.rejects(rt.startFixture({ workspace: ws, commandId, durationMs: 101 }), { code: 'COMMAND_CONFLICT' });
  await assert.rejects(rt.cancel(first.run.id, { commandId }), { code: 'COMMAND_CONFLICT' });
  assert.equal(rt.listRuns().length, 1);
  await rt.wait(first.run.id);
  const afterDone = await rt.startFixture({ workspace: ws, commandId, durationMs: 100 });
  assert.equal(afterDone.duplicate, true);
  assert.equal(rt.events(first.run.id).filter(event => event.type === 'process_started').length, 1);
});

test('d. concurrent processes cannot create two owners', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const reader = h.runtime(stateDir);
  const ws = h.dir('organis-rt-');
  const barrier = Date.now() + 2500;
  const workers = [h.helper(HELPER, helperParams(stateDir, ws, { barrier, commandId: randomId() })),
    h.helper(HELPER, helperParams(stateDir, ws, { barrier, commandId: randomId() }))];
  const results = await Promise.all(workers.map(worker => worker.next()));
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  const loser = results.find(result => !result.ok);
  assert.equal(loser.code, 'WORKSPACE_BUSY');
  assert.equal(reader.listRuns().length, 1);
  for (const worker of workers) await worker.exited;

  const ws2 = h.dir('organis-rt-');
  const commandId = randomId();
  const barrier2 = Date.now() + 2500;
  const dupes = [h.helper(HELPER, helperParams(stateDir, ws2, { barrier: barrier2, commandId })),
    h.helper(HELPER, helperParams(stateDir, ws2, { barrier: barrier2, commandId }))];
  const outcomes = await Promise.all(dupes.map(worker => worker.next()));
  assert.ok(outcomes.every(outcome => outcome.ok), JSON.stringify(outcomes));
  assert.equal(outcomes.filter(outcome => outcome.duplicate).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes[0].runId, outcomes[1].runId);
  assert.equal(reader.listRuns().filter(run => run.workspace === fs.realpathSync.native(ws2)).length, 1);
  for (const worker of dupes) await worker.exited;
  assert.equal(reader.getRun(outcomes[0].runId).state, 'completed');
});

test('e. cancel stays cancelling until owned processes are verified dead', OPTIONS, async t => {
  const h = harness(t);
  const rt = h.runtime(h.dir('organis-rt-'));
  const ws = h.dir('organis-rt-');
  const { run } = await rt.startFixture({ workspace: ws, mode: 'wait', durationMs: 0 });
  const ready = await waitReady(rt, run.id);
  assert.ok(ready.pid > 0 && ready.grandchildPid > 0);
  assert.ok(pidAlive(ready.pid) && pidAlive(ready.grandchildPid));
  const commandId = randomId();
  const requested = await rt.cancel(run.id, { commandId });
  assert.equal(requested.state, 'cancelling');
  assert.ok(requested.cancelRequestedAt);
  assert.equal((await rt.cancel(run.id, { commandId })).state, 'cancelling');
  const final = await rt.wait(run.id, { timeoutMs: 20000 });
  assert.equal(final.state, 'cancelled');
  await waitFor(() => !pidAlive(ready.pid), { timeoutMs: 1000, label: 'exited process cleanup' });
  assert.equal(pidAlive(ready.pid), false);
  assert.equal(pidAlive(ready.grandchildPid), false);
  assert.equal(rt.events(run.id).filter(event => event.type === 'cancel_requested').length, 1);
  assert.equal(rt.events(run.id).at(-1).type, 'cancelled');
  assert.equal((await rt.cancel(run.id)).state, 'cancelled');
  const next = await rt.startFixture({ workspace: ws, durationMs: 0 });
  assert.equal((await rt.wait(next.run.id)).state, 'completed');
});

test('e2. cancel before launch never spawns a process', OPTIONS, async t => {
  const h = harness(t);
  const rt = h.runtime(h.dir('organis-rt-'));
  const ws = h.dir('organis-rt-');
  const { run } = await rt.startFixture({ workspace: ws, mode: 'wait' });
  assert.equal((await rt.cancel(run.id)).state, 'cancelling');
  const final = await rt.wait(run.id, { timeoutMs: 10000 });
  assert.equal(final.state, 'cancelled');
  assert.equal(final.processPid, null);
  assert.equal(rt.events(run.id).some(event => event.type === 'process_started'), false);
});

test('f. a second client can request cancellation; the owner performs it', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const owner = h.runtime(stateDir);
  const ws = h.dir('organis-rt-');
  const { run } = await owner.startFixture({ workspace: ws, mode: 'wait' });
  const ready = await waitReady(owner, run.id);
  const reader = h.runtime(stateDir);
  assert.equal(reader.getRun(run.id).state, 'running');
  const requested = await reader.cancel(run.id);
  assert.equal(requested.state, 'cancelling');
  const final = await owner.wait(run.id, { timeoutMs: 20000 });
  assert.equal(final.state, 'cancelled');
  assert.equal(reader.getRun(run.id).state, 'cancelled');
  await pidsDead(ready.pid, ready.grandchildPid);
  await reader.close();
  assert.equal(owner.getRun(run.id).state, 'cancelled');
  assert.equal(owner.listRuns().length, 1);
  assert.equal(owner.events(run.id).filter(event => event.type === 'cancelled').length, 1);
});

test('g. owner crash is reconciled as interrupted without relaunch', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const ws = h.dir('organis-rt-');
  const worker = h.helper(HELPER, helperParams(stateDir, ws, { mode: 'wait', commandId: randomId() }));
  const started = await worker.next();
  assert.ok(started.ok, JSON.stringify(started));
  const peek = h.runtime(stateDir);
  const ready = await waitReady(peek, started.runId);
  await peek.close();
  process.kill(worker.child.pid);
  await worker.exited;

  const rt = h.runtime(stateDir);
  const interrupted = rt.getRun(started.runId);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.errorCode, 'OWNER_LOST');
  assert.equal(rt.events(started.runId).filter(event => event.type === 'process_started').length, 1);
  await pidsDead(ready.pid, ready.grandchildPid);
  rt.reconcile();
  const settled = rt.getRun(started.runId);
  assert.equal(settled.state, 'interrupted');
  assert.equal(settled.ownershipRetained, false);
  assert.equal(rt.events(started.runId).filter(event => event.type === 'process_started').length, 1);
  assert.equal(rt.listRuns().length, 1);
  const next = await rt.startFixture({ workspace: ws, durationMs: 50 });
  assert.equal((await rt.wait(next.run.id)).state, 'completed');
});

test('h. recovered pids are never killed and keep the workspace busy', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const ws = h.dir('organis-rt-');
  await new LocalRuntime({ stateDir }).close();
  const short = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise(resolve => short.once('exit', resolve));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const unrelatedExit = new Promise(resolve => unrelated.once('exit', resolve));
  h.push(() => { if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill(); });
  await waitFor(() => pidAlive(unrelated.pid), { label: 'unrelated helper' });

  const canonical = fs.realpathSync.native(ws);
  const key = process.platform === 'win32' || process.platform === 'darwin' ? canonical.toLowerCase() : canonical;
  const stat = fs.statSync(canonical, { bigint: true });
  const runId = randomId();
  const db = new DatabaseSync(path.join(stateDir, 'runtime.sqlite'));
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO owners(id,pid,hostname,started_at,heartbeat_at,closed_at) VALUES(?,?,?,?,?,NULL)')
    .run('synthetic-dead-owner', short.pid, 'synthetic-host', stamp, Date.now());
  db.prepare('INSERT INTO runs(id,task_id,attempt_id,room_id,participant_id,command_id,workspace_key,workspace,mode,duration_ms,'
    + "scope,state,approval_state,owner_id,coordinator_pid,process_pid,ownership_retained,created_at,updated_at,started_at) "
    + "VALUES(?,?,?,?,?,?,?,?,'wait',0,'trusted-workspace','running','not_required','synthetic-dead-owner',?,?,0,?,?,?)")
    .run(runId, randomId(), randomId(), randomId(), randomId(), randomId(), key, canonical, short.pid, unrelated.pid, stamp, stamp, stamp);
  db.prepare('INSERT INTO workspaces(key,file_id,path,busy_run_id) VALUES(?,?,?,?)').run(key, `${stat.dev}:${stat.ino}`, canonical, runId);
  db.close();

  const rt = h.runtime(stateDir);
  const run = rt.getRun(runId);
  assert.equal(run.state, 'interrupted');
  assert.equal(run.errorCode, 'OWNER_LOST');
  assert.equal(run.ownershipRetained, true);
  await assert.rejects(rt.startFixture({ workspace: ws }), { code: 'WORKSPACE_BUSY' });
  assert.equal(pidAlive(unrelated.pid), true);
  assert.deepEqual(rt.reconcile(), []);
  assert.equal(pidAlive(unrelated.pid), true);

  unrelated.kill();
  await unrelatedExit;
  await waitFor(() => !pidAlive(unrelated.pid), { label: 'unrelated helper to die' });
  const changed = rt.reconcile();
  assert.equal(changed.length, 1);
  assert.equal(rt.getRun(runId).ownershipRetained, false);
  assert.ok(rt.events(runId).some(event => event.type === 'ownership_retained'));
  assert.ok(rt.events(runId).some(event => event.type === 'ownership_released'));
  const next = await rt.startFixture({ workspace: ws, durationMs: 0 });
  assert.equal((await rt.wait(next.run.id)).state, 'completed');
});

test('h2. stale heartbeat with a live owner pid is suspect, not interrupted', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const ws = h.dir('organis-rt-');
  const owner = h.runtime(stateDir);
  const { run } = await owner.startFixture({ workspace: ws, mode: 'wait' });
  await waitReady(owner, run.id);
  const db = new DatabaseSync(path.join(stateDir, 'runtime.sqlite'));
  db.prepare('UPDATE owners SET heartbeat_at=? WHERE id=?').run(1, owner.ownerId);
  db.close();
  const reader = h.runtime(stateDir, { staleAfterMs: 1000 });
  assert.equal(reader.getRun(run.id).state, 'running');
  reader.reconcile();
  assert.equal(reader.events(run.id).filter(event => event.type === 'owner_suspect').length, 1);
  await reader.close();
  await owner.cancel(run.id);
  assert.equal((await owner.wait(run.id, { timeoutMs: 20000 })).state, 'cancelled');
});

test('i. persistence failure never produces completed', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const ws = h.dir('organis-rt-');
  const rt = h.runtime(stateDir, { busyTimeoutMs: 200 });
  const { run } = await rt.startFixture({ workspace: ws, durationMs: 1500 });
  await waitReady(rt, run.id);
  const blocker = new DatabaseSync(path.join(stateDir, 'runtime.sqlite'));
  h.push(() => { try { blocker.close(); } catch { /* already closed */ } });
  blocker.exec('PRAGMA busy_timeout=2000');
  blocker.exec('BEGIN EXCLUSIVE');
  let error;
  try {
    await Promise.race([rt.wait(run.id), sleep(10000).then(() => { throw new Error('wait did not reject in time'); })]);
    assert.fail('wait() must not resolve while persistence is failing');
  } catch (caught) { error = caught; }
  assert.ok(error instanceof RuntimeError, String(error));
  assert.equal(error.code, 'PERSISTENCE_FAILED');
  assert.equal(error.retryable, true);
  blocker.exec('ROLLBACK');
  blocker.close();
  let final;
  await waitFor(() => {
    final = rt.getRun(run.id);
    assert.notEqual(final.state, 'completed');
    return final.state === 'interrupted';
  }, { timeoutMs: 5000, label: 'interrupted' });
  assert.equal(final.errorCode, 'PERSISTENCE_FAILED');
  assert.equal(final.ownershipRetained, false);
  assert.ok(rt.events(run.id).some(event => event.type === 'interrupted' && event.reason === 'persistence_failed'));
  assert.equal(rt.events(run.id).some(event => event.type === 'completed'), false);
  const next = await rt.startFixture({ workspace: ws, durationMs: 0 });
  assert.equal((await rt.wait(next.run.id)).state, 'completed');
});

test('j. future schema versions are rejected without writes', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const file = path.join(stateDir, 'runtime.sqlite');
  const seed = new DatabaseSync(file);
  seed.exec('PRAGMA user_version=99');
  seed.close();
  assert.throws(() => new LocalRuntime({ stateDir }), error => error.code === 'SCHEMA_TOO_NEW' && error.retryable === false);
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []);
  db.close();
  const fresh = h.dir('organis-rt-');
  h.runtime(fresh);
  const created = new DatabaseSync(path.join(fresh, 'runtime.sqlite'));
  assert.equal(created.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(created.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  created.close();
});

test('k. credentials never reach the fixture or the state files', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const ws = h.dir('organis-rt-');
  const secrets = { ORGANIS_SYNTHETIC_SECRET: 'synthetic-secret-value-123', OPENAI_API_KEY: 'sk-synthetic-xyz', GITHUB_TOKEN: 'ghp_synthetic000' };
  const saved = Object.fromEntries(Object.keys(secrets).map(name => [name, process.env[name]]));
  Object.assign(process.env, secrets);
  const rt = h.runtime(stateDir);
  let id;
  try {
    id = (await rt.startFixture({ workspace: ws, durationMs: 100 })).run.id;
    const done = await rt.wait(id);
    assert.equal(done.state, 'completed', JSON.stringify({ errorCode: done.errorCode, ready: readyEvent(rt, id) }));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  const { envKeys } = readyEvent(rt, id);
  assert.ok(envKeys.length > 0);
  const allowed = new Set(['organis_fixture', 'electron_run_as_node', 'systemroot']);
  if (process.platform === 'darwin') allowed.add('__cf_user_text_encoding');
  if (process.platform === 'win32') {
    // libuv re-adds these from the parent on Windows; see fixture-process.mjs.
    for (const name of ['homedrive', 'homepath', 'logonserver', 'path', 'systemdrive', 'temp', 'userdomain',
      'username', 'userprofile', 'windir']) allowed.add(name);
  }
  for (const key of envKeys) {
    assert.equal(Object.hasOwn(secrets, key), false, key);
    assert.ok(allowed.has(key.toLowerCase()), `unexpected env key ${key}`);
  }
  await rt.close();
  const base = path.join(stateDir, 'runtime.sqlite');
  for (const file of [base, `${base}-wal`, `${base}-shm`]) {
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    for (const value of Object.values(secrets)) assert.equal(bytes.includes(value), false, `${path.basename(file)} leaked a secret`);
  }
});

test('k2. fixture refuses to run with a leaked environment variable', OPTIONS, async t => {
  const h = harness(t);
  const fixture = path.resolve(import.meta.dirname, '../packages/runtime/src/fixture-process.mjs');
  const env = { ORGANIS_FIXTURE: '1', LEAK_PROBE_SYNTHETIC: '1' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, [fixture, '--role', 'child', '--mode', 'complete', '--duration', '10'], {
    shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env
  });
  h.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const messages = [];
  child.on('message', message => messages.push(message));
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 4);
  assert.deepEqual(messages.map(message => message.type), ['ready', 'result']);
  assert.deepEqual(messages[1], { type: 'result', ok: false, code: 'ENV_LEAK' });
  assert.ok(messages[0].envKeys.includes('LEAK_PROBE_SYNTHETIC'));
  await pidsDead(messages[0].grandchildPid);
});

test('l. close cancels owned runs but leaves other owners alone', OPTIONS, async t => {
  const h = harness(t);
  const stateDir = h.dir('organis-rt-');
  const ws = h.dir('organis-rt-');
  const owner = h.runtime(stateDir);
  const { run } = await owner.startFixture({ workspace: ws, mode: 'wait' });
  const ready = await waitReady(owner, run.id);
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  await assert.rejects(owner.startFixture({ workspace: ws }), { code: 'RUNTIME_CLOSED' });
  await closing;
  await assert.rejects(async () => owner.getRun(run.id), { code: 'RUNTIME_CLOSED' });
  const check = h.runtime(stateDir);
  assert.equal(check.getRun(run.id).state, 'cancelled');
  await pidsDead(ready.pid, ready.grandchildPid);

  const second = h.runtime(stateDir);
  const live = await second.startFixture({ workspace: ws, mode: 'wait' });
  const liveReady = await waitReady(second, live.run.id);
  const reader = h.runtime(stateDir);
  await reader.close();
  assert.equal(second.getRun(live.run.id).state, 'running');
  assert.ok(pidAlive(liveReady.pid));
  await second.cancel(live.run.id);
  assert.equal((await second.wait(live.run.id, { timeoutMs: 20000 })).state, 'cancelled');
});

test('m. default state directory is under the user home', () => {
  assert.equal(defaultStateDir(), path.join(os.homedir(), '.organis', 'runtime'));
});

test('n. contracts are frozen and consistent', () => {
  assert.equal(IMPLEMENTED_STATES.includes('awaiting_approval'), false);
  assert.equal(RUN_STATES.includes('awaiting_approval'), true);
  assert.deepEqual([...RUN_STATES].sort(), [...LIVE_STATES, ...TERMINAL_STATES].sort());
  for (const state of TERMINAL_STATES) assert.deepEqual(TRANSITIONS[state], []);
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    assert.ok(RUN_STATES.includes(from));
    for (const target of targets) assert.ok(RUN_STATES.includes(target));
  }
  assert.throws(() => assertTransition('completed', 'running'), { code: 'INVALID_TRANSITION' });
  assert.throws(() => assertTransition('queued', 'completed'), { code: 'INVALID_TRANSITION' });
  assert.doesNotThrow(() => assertTransition('running', 'cancelling'));
  assert.equal(Object.isFrozen(TRANSITIONS), true);
  assert.throws(() => { TRANSITIONS.queued.push('completed'); }, TypeError);
  for (const [code, info] of Object.entries(ERROR_CODES)) {
    assert.equal(typeof info.retryable, 'boolean', code);
    assert.equal(new RuntimeError(code, 'x').retryable, info.retryable);
  }
  assert.equal(ERROR_CODES.WORKSPACE_BUSY.retryable, true);
  assert.equal(ERROR_CODES.SANDBOX_UNSUPPORTED.retryable, false);
  assert.equal(FIXTURE_CAPABILITY.sandbox, false);
  assert.equal(FIXTURE_CAPABILITY.maxDurationMs, 30000);
  assert.deepEqual([...APPROVAL_STATES], ['not_required', 'pending', 'approved', 'rejected', 'expired']);
  for (const name of ['room', 'participant', 'message', 'host', 'artifact', 'approval']) {
    assert.equal(ENTITY_CONTRACTS[name].implemented, 'contract-only', name);
  }
  for (const name of ['workspace', 'task', 'run', 'attempt', 'event', 'agentCapability']) {
    assert.equal(ENTITY_CONTRACTS[name].implemented, 'm1-fixture', name);
  }
  assert.ok(ENTITY_CONTRACTS.message.fields.includes('sequence'));
  assert.ok(ENTITY_CONTRACTS.message.fields.includes('commandId'));
  assert.equal(APPROVAL_IDENTITY_CONTRACT.implemented, 'contract-only');
  assert.ok(Object.hasOwn(APPROVAL_IDENTITY_CONTRACT.fields, 'decidedBy'));
});
