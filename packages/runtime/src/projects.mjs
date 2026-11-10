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

async function availability(record) {
  try {
    const current = await resolveTarget(record.path);
    return current.path === record.path && current.kind === record.kind && current.identity === record.identity
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
    if (this.#db.prepare('SELECT 1 FROM projects WHERE path=? AND identity<>?').get(target.path, target.identity)) throw invalid('Remove the changed project registration first.');
    const project = this.#db.prepare(`
      INSERT INTO projects VALUES(?,?,?)
      ON CONFLICT(identity) DO UPDATE SET identity=excluded.identity
      WHERE projects.path=excluded.path
      RETURNING *
    `).get(randomUUID(), target.path, target.identity);
    if (!project) throw invalid('Remove the moved project registration first.');
    return snapshot({ ...project, kind: target.kind });
  }

  async setPath(id, input, access = 'read', expectedTarget) {
    if (!accesses.includes(access)) throw invalid('Access must be read, write or deny.');
    const project = this.#project(id);
    if (await availability(project) !== 'available') throw invalid('The project directory is unavailable or has changed.');
    const target = await resolveTarget(input);
    this.#checkTarget(target, expectedTarget);
    if (this.#db.prepare('SELECT 1 FROM project_paths WHERE project_id=? AND path=? AND identity<>?').get(id, target.path, target.identity)) {
      throw invalid('Remove the changed path registration first.');
    }
    const record = this.#db.prepare(`
      INSERT INTO project_paths VALUES(?,?,?,?,?,?)
      ON CONFLICT(project_id, identity) DO UPDATE SET access=excluded.access
      WHERE project_paths.path=excluded.path
      RETURNING id, path, identity, kind, access
    `).get(randomUUID(), id, target.path, target.identity, target.kind, access);
    if (!record) throw invalid('This target is already registered under another path.');
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
