import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeError, SCHEMA_VERSION } from './contracts.mjs';

const SCHEMA = `
CREATE TABLE owners(
  id TEXT PRIMARY KEY, pid INTEGER, hostname TEXT, started_at TEXT, heartbeat_at INTEGER, closed_at TEXT);
CREATE TABLE workspaces(
  key TEXT PRIMARY KEY, file_id TEXT UNIQUE, path TEXT, busy_run_id TEXT);
CREATE TABLE runs(
  id TEXT PRIMARY KEY, task_id TEXT, attempt_id TEXT, room_id TEXT, participant_id TEXT, command_id TEXT,
  workspace_key TEXT, workspace TEXT, mode TEXT, duration_ms INTEGER, scope TEXT, state TEXT, approval_state TEXT,
  owner_id TEXT, coordinator_pid INTEGER, process_pid INTEGER, grandchild_pid INTEGER, exit_code INTEGER,
  error_code TEXT, ownership_retained INTEGER DEFAULT 0, cancel_requested_at TEXT,
  created_at TEXT, updated_at TEXT, started_at TEXT, ended_at TEXT);
CREATE TABLE commands(
  command_id TEXT PRIMARY KEY, kind TEXT, payload_hash TEXT, run_id TEXT, created_at TEXT);
CREATE TABLE events(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, type TEXT, at TEXT, data TEXT);
CREATE INDEX events_run ON events(run_id, sequence);
`;

export class Store {
  constructor(stateDir, { busyTimeoutMs = 5000 } = {}) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.path = path.join(stateDir, 'runtime.sqlite');
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(Number(busyTimeoutMs ?? 5000)))}`);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) {
        throw new RuntimeError('SCHEMA_TOO_NEW',
          `Runtime state schema ${version} is newer than supported ${SCHEMA_VERSION}.`);
      }
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
      if (version === 0) {
        this.tx(() => {
          // Re-check inside the write lock: another process may have created it.
          if (this.db.prepare('PRAGMA user_version').get().user_version === 0) {
            this.db.exec(SCHEMA);
            this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
          }
        });
      }
    } catch (error) {
      try { this.db.close(); } catch { /* already closed */ }
      throw error;
    }
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* connection may have rolled back */ }
      throw error;
    }
  }

  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  // Must be called inside tx() together with the state change it describes.
  addEvent(runId, type, data = {}) {
    this.run('INSERT INTO events(run_id,type,at,data) VALUES(?,?,?,?)',
      runId, type, new Date().toISOString(), JSON.stringify(data));
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
