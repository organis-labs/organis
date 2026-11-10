import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { RuntimeError } from './contracts.mjs';
import { defaultStateDir } from './execution.mjs';

const schemaVersion = 1;
const accesses = ['read', 'write', 'deny'];
const invalid = message => new RuntimeError('INVALID_ARGUMENT', message);
const realpath = promisify(fs.realpath.native);
const resolveTarget = async input => {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')
      || (process.platform === 'win32' && !/^(?:[a-z]:|\\\\|\/\/)/i.test(input))) {
    throw invalid('Use an absolute path on this host.');
  }
  try {
    const canonical = await realpath(input);
    const stat = await fs.promises.stat(canonical, { bigint: true });
    if (stat.ino === 0n || !(stat.isFile() || stat.isDirectory())) throw new Error();
    return { path: canonical, kind: stat.isDirectory() ? 'directory' : 'file', identity: `${stat.dev}:${stat.ino}` };
  } catch {
    throw invalid('The path must identify an accessible regular file or directory on this host.');
  }
};

async function samePath(first, second) {
  if (first === second) return true;
  if (first.toLowerCase() !== second.toLowerCase()) return false;
  const firstRoot = path.parse(first).root;
  const secondRoot = path.parse(second).root;
  const parts = first.slice(firstRoot.length).split(path.sep);
  const otherParts = second.slice(secondRoot.length).split(path.sep);
  let parent = firstRoot;
  for (const [index, part] of parts.entries()) {
    if (part !== otherParts[index]) {
      // Distinguish a case alias from two directory entries (including hard links).
      const names = await fs.promises.readdir(parent);
      if (names.includes(part) && names.includes(otherParts[index])) return false;
    }
    parent = path.join(parent, part);
  }
  return true;
}

async function registeredTarget(rows, target) {
  const exact = rows.find(row => row.path === target.path);
  if (exact) return exact;
  for (const row of rows) {
    if (row.path.toLowerCase() !== target.path.toLowerCase()) continue;
    try {
      const current = await resolveTarget(row.path);
      if (current.identity === target.identity && await samePath(row.path, target.path)) return row;
    } catch {
      // An unverified alias must not select an existing registration.
    }
  }
  return undefined;
}

async function availability(record) {
  try {
    const current = await resolveTarget(record.path);
    return current.kind === record.kind && current.identity === record.identity && await samePath(record.path, current.path)
      ? 'available' : 'changed';
  } catch {
    return 'unavailable';
  }
}

async function snapshot({ identity, ...record }) {
  return { ...record, status: await availability({ ...record, identity }) };
}

export class ProjectRegistry {
  #db;

  constructor(stateDir = defaultStateDir(), { busyTimeoutMs = 5000 } = {}) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // A separate database lets independently updated clients keep using the M1 run store.
    this.#db = new DatabaseSync(path.join(stateDir, 'projects.sqlite'), { enableForeignKeyConstraints: true });
    try {
      this.#db.exec('PRAGMA busy_timeout=' + busyTimeoutMs);
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version > schemaVersion) throw new RuntimeError('SCHEMA_TOO_NEW', 'Project registry requires a newer Organis version.');
      if (version === 0) {
        this.#db.exec('BEGIN IMMEDIATE');
        const lockedVersion = this.#db.prepare('PRAGMA user_version').get().user_version;
        if (lockedVersion > schemaVersion) throw new RuntimeError('SCHEMA_TOO_NEW', 'Project registry requires a newer Organis version.');
        if (lockedVersion === 0) {
          this.#db.exec(`
            CREATE TABLE projects(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, identity TEXT NOT NULL UNIQUE);
            CREATE TABLE project_paths(
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              path TEXT NOT NULL, identity TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','directory')),
              access TEXT NOT NULL CHECK(access IN ('read','write','deny')),
              UNIQUE(project_id, path), UNIQUE(project_id, identity)
            );
            PRAGMA user_version=${schemaVersion};
          `);
        }
        this.#db.exec('COMMIT');
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close() { this.#db.close(); }

  list() {
    return Promise.all(this.#db.prepare('SELECT * FROM projects ORDER BY path').all()
      .map(project => snapshot({ ...project, kind: 'directory' })));
  }

  async preview(id) {
    const project = this.#project(id);
    const paths = this.#db.prepare('SELECT id, path, identity, kind, access FROM project_paths WHERE project_id=? ORDER BY path').all(id);
    const [projectPreview, pathPreviews] = await Promise.all([snapshot(project), Promise.all(paths.map(snapshot))]);
    return {
      project: projectPreview,
      paths: pathPreviews,
      requested: { sandbox: 'workspace-write', commandNetwork: false, approvalMode: 'manual', pathLifetime: 'until-removed' },
      effective: null,
      executionAvailable: false,
      reason: 'Saved settings only. Codex task execution, sandbox enforcement and approval decisions are unavailable.'
    };
  }

  inspectPath(input) {
    return resolveTarget(input);
  }

  async addProject(input, expectedTarget) {
    const target = await resolveTarget(input);
    this.#checkTarget(target, expectedTarget);
    if (target.kind !== 'directory') throw invalid('A project must be a directory.');
    const rows = this.#db.prepare('SELECT * FROM projects').all();
    const existing = await registeredTarget(rows, target);
    if (rows.some(row => row.identity === target.identity && row.id !== existing?.id)) {
      throw invalid('This directory is already registered under another path.');
    }
    const project = existing
      ? this.#db.prepare('UPDATE OR IGNORE projects SET identity=? WHERE id=? AND identity=? RETURNING *')
        .get(target.identity, existing.id, existing.identity)
      : this.#db.prepare('INSERT OR IGNORE INTO projects VALUES(?,?,?) RETURNING *')
        .get(randomUUID(), target.path, target.identity);
    if (!project) throw invalid('Project registration changed. Refresh and try again.');
    return snapshot({ ...project, kind: target.kind });
  }

  async setPath(id, input, access = 'read', expectedTarget) {
    if (!accesses.includes(access)) throw invalid('Access must be read, write or deny.');
    const project = this.#project(id);
    if (await availability(project) !== 'available') throw invalid('The project directory is unavailable or has changed.');
    const target = await resolveTarget(input);
    this.#checkTarget(target, expectedTarget);
    const rows = this.#db.prepare('SELECT id, path, identity, kind, access FROM project_paths WHERE project_id=?').all(id);
    const existing = await registeredTarget(rows, target);
    if (existing && existing.kind !== target.kind) throw invalid('The path kind changed. Remove its registration before adding it again.');
    if (rows.some(row => row.identity === target.identity && row.id !== existing?.id)) {
      throw invalid('This target is already registered under another path.');
    }
    // Serialize the final project check and path write with rebinds and deletes.
    // Filesystem probes above must finish before taking the database write lock.
    this.#db.exec('BEGIN IMMEDIATE');
    let record;
    try {
      if (this.#project(id).identity !== project.identity) throw invalid('Project registration changed. Refresh and try again.');
      record = existing
        ? this.#db.prepare(`
          UPDATE OR IGNORE project_paths SET identity=?, access=? WHERE id=? AND identity=?
          RETURNING id, path, identity, kind, access
        `).get(target.identity, access, existing.id, existing.identity)
        : this.#db.prepare(`
          INSERT OR IGNORE INTO project_paths VALUES(?,?,?,?,?,?) RETURNING id, path, identity, kind, access
        `).get(randomUUID(), id, target.path, target.identity, target.kind, access);
      if (!record) throw invalid('Path registration changed. Refresh and try again.');
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
    return snapshot(record);
  }

  removePath(id, pathId) {
    this.#project(id);
    if (typeof pathId !== 'string' || !this.#db.prepare('DELETE FROM project_paths WHERE project_id=? AND id=?').run(id, pathId).changes) {
      throw invalid('Registered path not found for this project.');
    }
  }

  removeProject(id) {
    if (typeof id !== 'string' || !this.#db.prepare('DELETE FROM projects WHERE id=?').run(id).changes) {
      throw invalid('Project not found.');
    }
  }

  #checkTarget(target, expected) {
    if (expected && (target.identity !== expected.identity || target.path !== expected.path || target.kind !== expected.kind)) {
      throw invalid('The selected target changed. Choose it again.');
    }
  }

  #project(id) {
    const row = typeof id === 'string' && this.#db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) throw invalid('Project not found.');
    return { ...row, kind: 'directory' };
  }
}
