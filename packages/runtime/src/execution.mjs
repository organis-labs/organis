import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_STATES, ERROR_CODES, ENTITY_CONTRACTS, FIXTURE_CAPABILITY, LIVE_STATES, RUN_STATES, RuntimeError,
  TERMINAL_STATES, TRANSITIONS, assertTransition
} from './contracts.mjs';
import { Store } from './store.mjs';
import { killOwnedTree, pidAlive, waitForOwnedExit } from './process-tree.mjs';

export {
  APPROVAL_STATES, ERROR_CODES, ENTITY_CONTRACTS, FIXTURE_CAPABILITY, LIVE_STATES, RUN_STATES, RuntimeError,
  TERMINAL_STATES, TRANSITIONS
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ['complete', 'fail', 'wait'];
const MAX_DURATION_MS = FIXTURE_CAPABILITY.maxDurationMs;
const SANDBOX_KEYS = ['sandbox', 'network', 'networkPolicy', 'isolation'];
const RESULT_CODES = new Set(['FIXTURE_FAILED', 'ENV_LEAK']);
const TICK_MS = 150;
const CLOSE_BOUND_MS = 8000;
const LIVE_SQL = LIVE_STATES.map(state => `'${state}'`).join(',');
const foldCase = process.platform === 'win32' || process.platform === 'darwin';

export function defaultStateDir() {
  return path.join(os.homedir(), '.organis', 'runtime');
}

// Desktop packaging copies the runtime outside app.asar, alongside its fixture.
const fixturePath = fileURLToPath(new URL('./fixture-process.mjs', import.meta.url));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Race bound that must not keep the process alive after the raced work finishes.
const bound = ms => new Promise(resolve => setTimeout(resolve, ms).unref());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fold = value => (foldCase ? value.toLowerCase() : value);
const now = () => new Date().toISOString();

function insideOrEqual(parent, child) {
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realOrNull(target) {
  try { return fs.realpathSync.native(target); } catch { return null; }
}

function toSnapshot(row) {
  return {
    id: row.id, taskId: row.task_id, attemptId: row.attempt_id, roomId: row.room_id,
    participantId: row.participant_id, commandId: row.command_id, workspace: row.workspace, mode: row.mode,
    durationMs: row.duration_ms, scope: row.scope, state: row.state, approvalState: row.approval_state,
    ownerId: row.owner_id, coordinatorPid: row.coordinator_pid, processPid: row.process_pid,
    exitCode: row.exit_code, errorCode: row.error_code, ownershipRetained: Boolean(row.ownership_retained),
    cancelRequestedAt: row.cancel_requested_at, createdAt: row.created_at, updatedAt: row.updated_at,
    startedAt: row.started_at, endedAt: row.ended_at
  };
}

function persistenceError(error) {
  if (error instanceof RuntimeError) return error;
  return new RuntimeError('PERSISTENCE_FAILED', 'Runtime state could not be read or written.', { cause: error });
}

export class LocalRuntime {
  #store;
  #stateDir;
  #stateDirReal;
  #staleAfterMs;
  #heartbeatMs;
  #ownerRegistered = false;
  #timer = null;
  #lastHeartbeat = 0;
  #lastRetainedCheck = 0;
  #closing = false;
  #closed = false;
  #closePromise = null;
  #locals = new Map();
  #pendingInterrupt = new Map();

  constructor({ stateDir = defaultStateDir(), busyTimeoutMs, staleAfterMs = 10000, heartbeatMs = 1000 } = {}) {
    this.#stateDir = path.resolve(stateDir);
    try {
      this.#store = new Store(this.#stateDir, { busyTimeoutMs });
    } catch (error) {
      throw persistenceError(error);
    }
    this.#stateDirReal = realOrNull(this.#stateDir) ?? this.#stateDir;
    this.#staleAfterMs = staleAfterMs;
    this.#heartbeatMs = heartbeatMs;
    this.ownerId = randomUUID();
    try {
      this.reconcile();
    } catch (error) {
      this.#store.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed) throw new RuntimeError('RUNTIME_CLOSED', 'The runtime is closed.');
  }

  #db(fn) {
    this.#assertOpen();
    try { return fn(); } catch (error) { throw persistenceError(error); }
  }

  #runRow(id) {
    return this.#store.get('SELECT * FROM runs WHERE id=?', id);
  }

  #requireRow(id) {
    const row = typeof id === 'string' ? this.#runRow(id) : undefined;
    if (!row) throw new RuntimeError('RUN_NOT_FOUND', 'Run not found.');
    return row;
  }

  #snapshot(id) {
    return toSnapshot(this.#runRow(id));
  }

  // ---- public API ----

  getRun(id) {
    return this.#db(() => toSnapshot(this.#requireRow(id)));
  }

  listRuns() {
    return this.#db(() => this.#store.all('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC').map(toSnapshot));
  }

  events(id, after = 0) {
    if (!Number.isInteger(after) || after < 0) throw new RuntimeError('INVALID_ARGUMENT', 'after must be a nonnegative integer.');
    return this.#db(() => {
      this.#requireRow(id);
      return this.#store.all('SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence', id, after)
        .map(row => ({ ...JSON.parse(row.data), sequence: row.sequence, runId: row.run_id, type: row.type, at: row.at }));
    });
  }

  async startFixture(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new RuntimeError('INVALID_ARGUMENT', 'startFixture options must be an object.');
    }
    const { workspace, commandId, mode = 'complete', durationMs = 250, scope = 'trusted-workspace',
      roomId, participantId, ...rest } = options;
    if (this.#closing || this.#closed) throw new RuntimeError('RUNTIME_CLOSED', 'The runtime is closed.');
    const restKeys = Object.keys(rest);
    if (restKeys.some(key => SANDBOX_KEYS.includes(key))) {
      throw new RuntimeError('SANDBOX_UNSUPPORTED', 'Sandbox, network and isolation enforcement are not supported by the local fixture runtime.');
    }
    if (restKeys.length) throw new RuntimeError('INVALID_ARGUMENT', `Unsupported options: ${restKeys.join(', ')}.`);
    if (typeof scope !== 'string') throw new RuntimeError('INVALID_ARGUMENT', 'scope must be a string.');
    if (scope !== FIXTURE_CAPABILITY.scope) {
      if (/sandbox|isolat|network/i.test(scope)) {
        throw new RuntimeError('SANDBOX_UNSUPPORTED', 'Sandbox, network and isolation scopes are not supported.');
      }
      throw new RuntimeError('SCOPE_DENIED', `Scope is not permitted; only ${FIXTURE_CAPABILITY.scope} is available.`);
    }
    if (!MODES.includes(mode)) throw new RuntimeError('INVALID_ARGUMENT', `mode must be one of ${MODES.join(', ')}.`);
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) {
      throw new RuntimeError('INVALID_ARGUMENT', `durationMs must be an integer from 0 to ${MAX_DURATION_MS}.`);
    }
    for (const [name, value] of [['commandId', commandId], ['roomId', roomId], ['participantId', participantId]]) {
      if (value !== undefined && (typeof value !== 'string' || !UUID.test(value))) {
        throw new RuntimeError('INVALID_ARGUMENT', `${name} must be a UUID.`);
      }
    }
    const { canonical, key, fileId } = this.#resolveWorkspace(workspace);
    const payloadHash = hash({ kind: 'startFixture', workspaceKey: key, mode, durationMs, scope,
      roomId: roomId ?? null, participantId: participantId ?? null });
    const ids = {
      runId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), commandId: commandId ?? randomUUID(),
      roomId: roomId ?? randomUUID(), participantId: participantId ?? randomUUID()
    };
    const result = this.#db(() => this.#store.tx(() => {
      const store = this.#store;
      const existing = store.get('SELECT * FROM commands WHERE command_id=?', ids.commandId);
      if (existing) {
        if (existing.kind === 'startFixture' && existing.payload_hash === payloadHash && existing.run_id) {
          return { duplicate: true, run: toSnapshot(this.#requireRow(existing.run_id)) };
        }
        throw new RuntimeError('COMMAND_CONFLICT', 'commandId was already used for a different command.');
      }
      const busy = store.all('SELECT * FROM workspaces WHERE key=? OR file_id=?', key, fileId)
        .find(row => row.busy_run_id);
      if (busy) throw new RuntimeError('WORKSPACE_BUSY', 'Another run holds this workspace.');
      const stamp = now();
      if (!this.#ownerRegistered) {
        store.run('INSERT OR REPLACE INTO owners(id,pid,hostname,started_at,heartbeat_at,closed_at) VALUES(?,?,?,?,?,NULL)',
          this.ownerId, process.pid, os.hostname(), stamp, Date.now());
      }
      store.run('INSERT INTO runs(id,task_id,attempt_id,room_id,participant_id,command_id,workspace_key,workspace,mode,'
        + 'duration_ms,scope,state,approval_state,owner_id,coordinator_pid,ownership_retained,created_at,updated_at) '
        + "VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued','not_required',?,?,0,?,?)",
        ids.runId, ids.taskId, ids.attemptId, ids.roomId, ids.participantId, ids.commandId, key, canonical, mode,
        durationMs, scope, this.ownerId, process.pid, stamp, stamp);
      store.run('INSERT INTO commands(command_id,kind,payload_hash,run_id,created_at) VALUES(?,?,?,?,?)',
        ids.commandId, 'startFixture', payloadHash, ids.runId, stamp);
      store.run('DELETE FROM workspaces WHERE key=? OR file_id=?', key, fileId);
      store.run('INSERT INTO workspaces(key,file_id,path,busy_run_id) VALUES(?,?,?,?)', key, fileId, canonical, ids.runId);
      store.addEvent(ids.runId, 'run_created', { mode, durationMs, scope });
      return { duplicate: false, run: this.#snapshot(ids.runId) };
    }));
    if (result.duplicate) return result;
    this.#ownerRegistered = true;
    this.#startTimer();
    const local = this.#newLocal(ids.runId, canonical, mode, durationMs);
    this.#locals.set(ids.runId, local);
    this.#timer.ref();
    setImmediate(() => this.#launch(local));
    return result;
  }

  async wait(id, { timeoutMs } = {}) {
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !(timeoutMs >= 0))) {
      throw new RuntimeError('INVALID_ARGUMENT', 'timeoutMs must be a nonnegative number.');
    }
    const row = this.#db(() => this.#requireRow(id));
    if (TERMINAL_STATES.includes(row.state)) return toSnapshot(row);
    const local = this.#locals.get(id);
    if (local) {
      if (timeoutMs === undefined) return local.promise;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new RuntimeError('WAIT_TIMEOUT', 'Timed out waiting for the run.')), timeoutMs);
      });
      try { return await Promise.race([local.promise, timeout]); } finally { clearTimeout(timer); }
    }
    const deadline = Date.now() + (timeoutMs ?? 60000);
    for (;;) {
      const snapshot = this.getRun(id);
      if (TERMINAL_STATES.includes(snapshot.state)) return snapshot;
      if (Date.now() >= deadline) throw new RuntimeError('WAIT_TIMEOUT', 'Timed out waiting for the run.');
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  async cancel(id, { commandId } = {}) {
    return this.#requestCancel(id, commandId);
  }

  reconcile() {
    this.#assertOpen();
    const rows = this.#db(() => this.#store.all(
      `SELECT id FROM runs WHERE (state IN (${LIVE_SQL}) AND owner_id IS NOT ?) OR (state='interrupted' AND ownership_retained=1)`,
      this.ownerId));
    const changed = [];
    for (const { id } of rows) {
      const snapshot = this.#db(() => this.#store.tx(() => this.#reconcileRun(id)));
      if (snapshot) changed.push(snapshot);
    }
    return changed;
  }

  close() {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  // ---- internals ----

  #resolveWorkspace(workspace) {
    const invalid = message => new RuntimeError('INVALID_WORKSPACE', message);
    if (typeof workspace !== 'string' || !workspace.trim() || !path.isAbsolute(workspace)) {
      throw invalid('workspace must be an absolute directory path.');
    }
    let stat;
    try { stat = fs.statSync(workspace); } catch { throw invalid('workspace does not exist.'); }
    if (!stat.isDirectory()) throw invalid('workspace is not a directory.');
    let canonical;
    let fileId;
    try {
      canonical = fs.realpathSync.native(workspace);
      const real = fs.statSync(canonical, { bigint: true });
      fileId = `${real.dev}:${real.ino}`;
    } catch { throw invalid('workspace could not be resolved.'); }
    const denied = () => new RuntimeError('SCOPE_DENIED', 'workspace is outside the permitted scope.');
    if (path.dirname(canonical) === canonical) throw denied();
    const home = realOrNull(os.homedir());
    if (home && fold(home) === fold(canonical)) throw denied();
    if (insideOrEqual(this.#stateDirReal, canonical) || insideOrEqual(canonical, this.#stateDirReal)) throw denied();
    return { canonical, key: fold(canonical), fileId };
  }

  #startTimer() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
    this.#timer.unref();
  }

  #newLocal(id, cwd, mode, durationMs) {
    const local = { id, cwd, mode, durationMs, child: null, exited: null, exitInfo: null, disconnected: null,
      grandchildPid: null, result: null, cancelPromise: null, nextCancelAt: 0, done: false, persistenceFailed: false };
    local.promise = new Promise((resolve, reject) => { local.resolve = resolve; local.reject = reject; });
    local.promise.catch(() => {});
    return local;
  }

  #settle(local) {
    if (local.done) return;
    local.done = true;
    this.#locals.delete(local.id);
    if (!this.#locals.size) this.#timer?.unref();
    try { local.resolve(this.#snapshot(local.id)); } catch (error) { local.reject(persistenceError(error)); }
  }

  #persistenceFailure(local, error) {
    if (local.done || local.persistenceFailed) return;
    local.persistenceFailed = true;
    this.#pendingInterrupt.set(local.id, Date.now());
    local.reject(new RuntimeError('PERSISTENCE_FAILED', 'Run state could not be persisted; the run was not marked completed.', { cause: error }));
    if (local.child && !local.exitInfo) {
      killOwnedTree({ child: local.child, grandchildPid: local.grandchildPid }).catch(() => {});
    }
  }

  #retryPending() {
    for (const [id, failedAt] of [...this.#pendingInterrupt]) {
      const local = this.#locals.get(id);
      const dead = !local?.child?.pid || (Boolean(local.exitInfo) && local.ready && !pidAlive(local.grandchildPid));
      if (!dead && Date.now() - failedAt < 10000) continue;
      try {
        this.#store.tx(() => {
          const stamp = now();
          const result = this.#store.run(
            `UPDATE runs SET state='interrupted', error_code='PERSISTENCE_FAILED', ended_at=?, updated_at=?, ownership_retained=? `
            + `WHERE id=? AND owner_id=? AND state IN (${LIVE_SQL})`,
            stamp, stamp, dead ? 0 : 1, id, this.ownerId);
          if (result.changes) {
            if (dead) this.#store.run('UPDATE workspaces SET busy_run_id=NULL WHERE busy_run_id=?', id);
            this.#store.addEvent(id, 'interrupted', { reason: 'persistence_failed' });
            if (!dead) this.#store.addEvent(id, 'ownership_retained', { processPid: local?.child?.pid ?? null, grandchildPid: local?.grandchildPid ?? null });
          }
        });
        this.#pendingInterrupt.delete(id);
        if (local) { local.done = true; this.#locals.delete(id); }
        if (!this.#locals.size) this.#timer?.unref();
      } catch { /* retry on the next tick */ }
    }
  }

  #tick() {
    if (this.#closed) return;
    if (Date.now() - this.#lastHeartbeat >= this.#heartbeatMs) {
      this.#lastHeartbeat = Date.now();
      try { this.#store.run('UPDATE owners SET heartbeat_at=? WHERE id=?', Date.now(), this.ownerId); } catch { /* visible through stale heartbeat */ }
    }
    for (const local of [...this.#locals.values()]) {
      if (local.done || local.persistenceFailed || local.cancelPromise || Date.now() < local.nextCancelAt) continue;
      try {
        if (this.#runRow(local.id)?.state === 'cancelling') this.#cancelLocal(local);
      } catch { /* retry on the next tick */ }
    }
    this.#retryPending();
    // Re-check retained ownership (this owner's unverified exits and recovered runs) so a long-lived
    // host releases a workspace once the recorded processes are gone. Never kills anything.
    if (Date.now() - this.#lastRetainedCheck >= 2000) {
      this.#lastRetainedCheck = Date.now();
      try {
        for (const { id } of this.#store.all('SELECT id FROM runs WHERE ownership_retained=1')) {
          this.#store.tx(() => this.#reconcileRun(id));
        }
      } catch { /* retry on the next check */ }
    }
  }

  #launch(local) {
    if (local.done || local.persistenceFailed || this.#closed) return;
    try {
      const row = this.#runRow(local.id);
      if (row?.state === 'cancelling') { this.#cancelLocal(local); return; }
      if (row?.state !== 'queued') { this.#settle(local); return; }
      // A crash before process identity is recorded must not look like a free lease.
      this.#store.tx(() => this.#store.addEvent(local.id, 'launch_requested'));
    } catch (error) { this.#persistenceFailure(local, error); return; }
    const env = { ORGANIS_FIXTURE: '1' };
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (systemRoot !== undefined) env.SystemRoot = systemRoot;
    }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    let child;
    try {
      child = spawn(process.execPath, [fixturePath, '--role', 'child', '--mode', local.mode, '--duration', String(local.durationMs)], {
        cwd: local.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env,
        detached: true
      });
    } catch { child = null; }
    if (!child) { this.#terminate(local, ['queued'], 'failed', 'SPAWN_FAILED', null); return; }
    local.child = child;
    local.exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); });
    local.disconnected = new Promise(resolve => { child.once('disconnect', resolve); });
    child.once('error', () => {
      if (local.spawned) return;
      local.child = null;
      this.#terminate(local, ['queued'], 'failed', 'SPAWN_FAILED', null);
    });
    child.once('spawn', () => this.#guard(local, () => this.#onSpawn(local)));
    child.on('message', message => this.#guard(local, () => this.#onMessage(local, message)));
    child.once('exit', (code, signal) => {
      local.exitInfo = { code, signal };
      if (local.cancelPromise || local.done || local.persistenceFailed) return;
      this.#afterExit(local).catch(error => this.#persistenceFailure(local, error));
    });
  }

  #guard(local, fn) {
    if (local.done || local.persistenceFailed) return;
    try { fn(); } catch (error) { this.#persistenceFailure(local, error); }
  }

  #onSpawn(local) {
    local.spawned = true;
    const pid = local.child.pid;
    const changed = this.#store.tx(() => {
      const stamp = now();
      const result = this.#store.run(
        "UPDATE runs SET state='running', process_pid=?, started_at=?, updated_at=? WHERE id=? AND owner_id=? AND state='queued'",
        pid, stamp, stamp, local.id, this.ownerId);
      if (result.changes) this.#store.addEvent(local.id, 'process_started', { pid });
      else this.#store.run("UPDATE runs SET process_pid=? WHERE id=? AND owner_id=? AND state='cancelling'", pid, local.id, this.ownerId);
      return result.changes;
    });
    if (changed) return;
    if (this.#runRow(local.id)?.state === 'cancelling') this.#cancelLocal(local);
    else killOwnedTree({ child: local.child, grandchildPid: local.grandchildPid }).catch(() => {});
  }

  #onMessage(local, message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready' && !local.ready) {
      local.ready = true;
      const pid = Number.isInteger(message.pid) ? message.pid : null;
      const grandchildPid = Number.isInteger(message.grandchildPid) && message.grandchildPid > 0 ? message.grandchildPid : null;
      const envKeys = Array.isArray(message.envKeys)
        ? message.envKeys.filter(key => typeof key === 'string').slice(0, 256).map(key => key.slice(0, 128)) : [];
      local.grandchildPid = grandchildPid;
      this.#store.tx(() => {
        const result = this.#store.run(
          `UPDATE runs SET grandchild_pid=?, updated_at=? WHERE id=? AND owner_id=? AND state IN ('running','cancelling')`,
          grandchildPid, now(), local.id, this.ownerId);
        if (result.changes) this.#store.addEvent(local.id, 'fixture_ready', {
          pid, grandchildPid, envKeys, cwd: typeof message.cwd === 'string' ? message.cwd : null
        });
      });
      // ESM startup can precede the fixture's IPC listener; repeat a queued cancel
      // once readiness proves the cooperative listener is installed.
      if (this.#runRow(local.id)?.state === 'cancelling' && local.child.connected) {
        local.child.send({ type: 'cancel' }, () => {});
      }
    } else if (message.type === 'result' && typeof message.ok === 'boolean') {
      local.result = { ok: message.ok, code: RESULT_CODES.has(message.code) ? message.code : undefined };
    }
  }

  async #afterExit(local) {
    await Promise.race([local.disconnected, bound(2000)]);
    const target = { exited: local.exited, grandchildPid: () => local.grandchildPid, ready: () => Boolean(local.ready) };
    let dead = await waitForOwnedExit(target, 3000);
    if (!dead) {
      await killOwnedTree({ child: local.child, grandchildPid: local.grandchildPid });
      dead = await waitForOwnedExit(target, 3000);
    }
    if (local.cancelPromise || local.done || local.persistenceFailed) return;
    const { code, signal } = local.exitInfo;
    if (!dead) {
      this.#terminate(local, ['running'], 'interrupted', 'TERMINATION_UNVERIFIED', code, true);
      return;
    }
    const ok = code === 0 && signal === null && local.result?.ok === true && dead;
    this.#terminate(local, ['running'], ok ? 'completed' : 'failed',
      ok ? null : (local.result?.code || 'FIXTURE_FAILED'), code);
  }

  // Terminal transition for a run this owner executes. Never reports completed unless the tx commits.
  #terminate(local, fromStates, state, errorCode, exitCode, retainOwnership = false) {
    if (local.done || local.persistenceFailed) return;
    let changed;
    try {
      changed = this.#store.tx(() => {
        const stamp = now();
        const from = fromStates.map(item => `'${item}'`).join(',');
        const result = this.#store.run(
          `UPDATE runs SET state=?, error_code=?, exit_code=?, ended_at=?, updated_at=?, ownership_retained=? WHERE id=? AND owner_id=? AND state IN (${from})`,
          state, errorCode, exitCode ?? null, stamp, stamp, retainOwnership ? 1 : 0, local.id, this.ownerId);
        if (!result.changes) return false;
        if (!retainOwnership) this.#store.run('UPDATE workspaces SET busy_run_id=NULL WHERE busy_run_id=?', local.id);
        else this.#store.addEvent(local.id, 'ownership_retained', { reason: 'termination_unverified' });
        this.#store.addEvent(local.id, state, { exitCode: exitCode ?? null, errorCode });
        return true;
      });
    } catch (error) { this.#persistenceFailure(local, error); return; }
    if (changed) { this.#settle(local); return; }
    try {
      const current = this.#runRow(local.id);
      if (current?.state === 'cancelling') this.#cancelLocal(local);
      else this.#settle(local);
    } catch (error) { this.#persistenceFailure(local, error); }
  }

  #cancelLocal(local) {
    if (local.cancelPromise || local.done || local.persistenceFailed) return local.cancelPromise ?? Promise.resolve();
    local.cancelPromise = this.#doCancel(local)
      .catch(error => this.#persistenceFailure(local, error))
      .finally(() => { local.cancelPromise = null; });
    return local.cancelPromise;
  }

  async #doCancel(local) {
    if (!local.child) {
      this.#store.tx(() => {
        const stamp = now();
        const result = this.#store.run(
          "UPDATE runs SET state='cancelled', error_code=NULL, ownership_retained=0, ended_at=?, updated_at=? WHERE id=? AND owner_id=? AND state='cancelling'",
          stamp, stamp, local.id, this.ownerId);
        if (!result.changes) return;
        this.#store.run('UPDATE workspaces SET busy_run_id=NULL WHERE busy_run_id=?', local.id);
        this.#store.addEvent(local.id, 'cancelled', { exitCode: null });
      });
      this.#settle(local);
      return;
    }
    try {
      if (local.child.connected) local.child.send({ type: 'cancel' }, () => {});
    } catch { /* channel already closed */ }
    const target = { exited: local.exited, grandchildPid: () => local.grandchildPid, ready: () => Boolean(local.ready) };
    const startupDeadline = Date.now() + 10000;
    while (!local.ready && !local.exitInfo && Date.now() < startupDeadline) await sleep(50);
    let dead = await waitForOwnedExit(target, 1500);
    if (!dead) {
      await killOwnedTree({ child: local.child, grandchildPid: local.grandchildPid });
      dead = await waitForOwnedExit(target, 5000);
    }
    if (dead) {
      await Promise.race([local.disconnected, bound(2000)]);
      const exitCode = (await local.exited).code ?? null;
      this.#store.tx(() => {
        const stamp = now();
        const result = this.#store.run(
          "UPDATE runs SET state='cancelled', error_code=NULL, ownership_retained=0, exit_code=?, ended_at=?, updated_at=? WHERE id=? AND owner_id=? AND state='cancelling'",
          exitCode, stamp, stamp, local.id, this.ownerId);
        if (!result.changes) return;
        this.#store.run('UPDATE workspaces SET busy_run_id=NULL WHERE busy_run_id=?', local.id);
        this.#store.addEvent(local.id, 'cancelled', { exitCode });
      });
      this.#settle(local);
      return;
    }
    local.nextCancelAt = Date.now() + 2000;
    this.#store.tx(() => {
      const result = this.#store.run(
        "UPDATE runs SET error_code='CANCEL_UNVERIFIED', ownership_retained=1, updated_at=? WHERE id=? AND owner_id=? AND state='cancelling' AND (error_code IS NOT 'CANCEL_UNVERIFIED')",
        now(), local.id, this.ownerId);
      if (result.changes) this.#store.addEvent(local.id, 'cancel_unverified', {});
    });
  }

  #requestCancel(id, commandId) {
    if (commandId !== undefined && (typeof commandId !== 'string' || !UUID.test(commandId))) {
      throw new RuntimeError('INVALID_ARGUMENT', 'commandId must be a UUID.');
    }
    const snapshot = this.#db(() => this.#store.tx(() => {
      const row = this.#requireRow(id);
      if (commandId) {
        const payloadHash = hash({ kind: 'cancel', runId: id });
        const existing = this.#store.get('SELECT * FROM commands WHERE command_id=?', commandId);
        if (existing) {
          if (existing.kind !== 'cancel' || existing.payload_hash !== payloadHash) {
            throw new RuntimeError('COMMAND_CONFLICT', 'commandId was already used for a different command.');
          }
        } else {
          this.#store.run('INSERT INTO commands(command_id,kind,payload_hash,run_id,created_at) VALUES(?,?,?,?,?)',
            commandId, 'cancel', payloadHash, id, now());
        }
      }
      if (LIVE_STATES.includes(row.state) && row.state !== 'cancelling') {
        assertTransition(row.state, 'cancelling');
        const stamp = now();
        this.#store.run(
          'UPDATE runs SET state=?, cancel_requested_at=?, updated_at=? WHERE id=?', 'cancelling', stamp, stamp, id);
        this.#store.addEvent(id, 'cancel_requested', { commandId: commandId ?? null });
      }
      return this.#snapshot(id);
    }));
    const local = this.#locals.get(id);
    if (local && snapshot.state === 'cancelling') this.#cancelLocal(local);
    return snapshot;
  }

  #reconcileRun(id) {
    const store = this.#store;
    const row = this.#runRow(id);
    if (!row) return null;
    let changed = false;
    let interruptedNow = false;
    if (LIVE_STATES.includes(row.state)) {
      if (row.owner_id === this.ownerId) return null;
      const owner = store.get('SELECT * FROM owners WHERE id=?', row.owner_id);
      const ownerDead = !owner || owner.closed_at != null || !pidAlive(owner.pid);
      if (!ownerDead) {
        const stale = Date.now() - Number(owner.heartbeat_at ?? 0) > this.#staleAfterMs;
        const suspected = store.get("SELECT 1 AS found FROM events WHERE run_id=? AND type='owner_suspect' LIMIT 1", id);
        if (stale && !suspected) {
          store.addEvent(id, 'owner_suspect', { ownerId: row.owner_id, heartbeatAt: owner.heartbeat_at ?? null });
          return this.#snapshot(id);
        }
        return null;
      }
      assertTransition(row.state, 'interrupted');
      const stamp = now();
      store.run("UPDATE runs SET state='interrupted', error_code='OWNER_LOST', ended_at=?, updated_at=? WHERE id=?", stamp, stamp, id);
      store.addEvent(id, 'interrupted', { reason: 'owner_lost' });
      changed = true;
      interruptedNow = true;
    }
    const fresh = this.#runRow(id);
    if (!interruptedNow && !fresh.ownership_retained) return null;
    const launchRequested = store.get("SELECT 1 FROM events WHERE run_id=? AND type='launch_requested' LIMIT 1", id);
    const readyRecorded = store.get("SELECT 1 FROM events WHERE run_id=? AND type='fixture_ready' LIMIT 1", id);
    const unknownTree = Boolean(launchRequested && !readyRecorded);
    const processDead = !unknownTree && (!fresh.process_pid || !pidAlive(fresh.process_pid))
      && (!fresh.grandchild_pid || !pidAlive(fresh.grandchild_pid));
    if (processDead) {
      const released = store.run('UPDATE workspaces SET busy_run_id=NULL WHERE busy_run_id=?', id);
      if (fresh.ownership_retained || released.changes) {
        store.run('UPDATE runs SET ownership_retained=0, updated_at=? WHERE id=?', now(), id);
        store.addEvent(id, 'ownership_released', {});
        changed = true;
      }
    } else if (!fresh.ownership_retained) {
      store.run('UPDATE runs SET ownership_retained=1, updated_at=? WHERE id=?', now(), id);
      store.addEvent(id, 'ownership_retained', { processPid: fresh.process_pid, grandchildPid: fresh.grandchild_pid,
        reason: unknownTree ? 'launch_identity_unverified' : 'process_still_present' });
      changed = true;
    }
    return changed ? this.#snapshot(id) : null;
  }

  async #close() {
    this.#closing = true;
    const locals = [...this.#locals.values()];
    const work = Promise.allSettled(locals.map(async local => {
      if (local.done) return;
      if (!local.persistenceFailed) {
        try { this.#requestCancel(local.id); } catch { return; }
      }
      await local.promise;
    }));
    await Promise.race([work, bound(CLOSE_BOUND_MS)]);
    if (this.#pendingInterrupt.size) this.#retryPending();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#ownerRegistered) {
      try { this.#store.run('UPDATE owners SET closed_at=? WHERE id=?', now(), this.ownerId); } catch { /* owner stays unclosed */ }
    }
    this.#closed = true;
    this.#store.close();
  }
}
