import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectRegistry } from '../packages/runtime/src/projects.mjs';
import { Store } from '../packages/runtime/src/store.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'organis-projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'project with spaces');
  mkdirSync(workspace);
  const file = join(workspace, 'context.txt');
  writeFileSync(file, 'synthetic');
  return { root, workspace, file, state: join(root, 'state') };
}

test('CLI and a separate registry connection share local requests without changing the run schema', async t => {
  const { workspace, file, state } = setup(t);
  const cli = (...args) => {
    const result = spawnSync(process.execPath, ['apps/cli/src/main.mjs', 'project', ...args, '--state-dir', state, '--json'],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const { project } = cli('add', workspace);
  const { path: saved } = cli('set-path', project.id, file);
  assert.equal(saved.kind, 'file');
  assert.equal(saved.access, 'read');
  assert.equal(existsSync(join(state, 'runtime.sqlite')), false);
  const registry = new ProjectRegistry(state);
  try {
    const preview = await registry.preview(project.id);
    assert.deepEqual(preview.paths, [saved]);
    assert.equal(preview.requested.pathLifetime, 'until-removed');
    assert.equal(preview.requested.commandNetwork, false);
    assert.equal(preview.effective, null);
    assert.equal(preview.executionAvailable, false);
    assert.equal((await registry.setPath(project.id, file, 'deny')).id, saved.id);
    assert.equal(cli('show', project.id).paths[0].access, 'deny');
    cli('remove-path', project.id, saved.id);
    assert.deepEqual((await registry.preview(project.id)).paths, []);
    await registry.setPath(project.id, file);
    cli('remove', project.id);
    assert.deepEqual(await registry.list(), []);
    const replacement = await registry.addProject(workspace);
    assert.deepEqual((await registry.preview(replacement.id)).paths, []);
  } finally {
    registry.close();
  }
  const runStore = new Store(state);
  try {
    assert.equal(runStore.get('PRAGMA user_version').user_version, 1);
  } finally {
    runStore.close();
  }
});

test('project aliases resolve to one canonical directory and replacement can be explicitly rebound', async t => {
  const { root, workspace, file, state } = setup(t);
  const registry = new ProjectRegistry(state);
  try {
    await assert.rejects(() => registry.addProject('relative/path'), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(() => registry.addProject(file), { code: 'INVALID_ARGUMENT' });
    const alias = join(root, 'alias');
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const project = await registry.addProject(alias);
    assert.deepEqual(await registry.addProject(workspace), project);
    const candidate = await registry.inspectPath(file);
    const saved = await registry.setPath(project.id, file, 'write');
    renameSync(file, join(workspace, 'old.txt'));
    assert.equal((await registry.preview(project.id)).paths[0].status, 'unavailable');
    writeFileSync(file, 'replacement');
    assert.equal((await registry.preview(project.id)).paths[0].status, 'changed');
    await assert.rejects(() => registry.setPath(project.id, file, 'deny', candidate), /selected target changed/);
    const refreshed = await registry.setPath(project.id, file, 'deny');
    assert.deepEqual(refreshed, { ...saved, access: 'deny', status: 'available' });
    const moved = join(root, 'old-project');
    renameSync(workspace, moved);
    await assert.rejects(() => registry.addProject(moved), /already registered under another path/);
    mkdirSync(workspace);
    assert.equal((await registry.preview(project.id)).project.status, 'changed');
    await assert.rejects(() => registry.setPath(project.id, workspace, 'read'), /project directory.*changed/);
    const refreshedProject = await registry.addProject(workspace);
    assert.deepEqual(refreshedProject, project);
    const preview = await registry.preview(project.id);
    assert.deepEqual(preview.paths, [{ ...refreshed, status: 'unavailable' }]);
    writeFileSync(file, 'new file in the replacement workspace');
    assert.equal((await registry.preview(project.id)).paths[0].status, 'changed');
    assert.equal((await registry.setPath(project.id, file, 'deny')).id, saved.id);
  } finally {
    registry.close();
  }
});

test('case aliases share a registration only on a filesystem that resolves them to the same entry', async t => {
  const { root, workspace, file, state } = setup(t);
  const directoryAlias = join(root, 'PROJECT WITH SPACES');
  const fileAlias = join(workspace, 'CONTEXT.TXT');
  const registry = new ProjectRegistry(state);
  try {
    const project = await registry.addProject(workspace);
    const saved = await registry.setPath(project.id, file, 'write');
    if (existsSync(directoryAlias)) {
      t.diagnostic('Verified case-insensitive aliases on the native filesystem.');
      assert.deepEqual(await registry.addProject(directoryAlias), project);
      assert.deepEqual(await registry.setPath(project.id, fileAlias, 'deny'), { ...saved, access: 'deny' });
      renameSync(file, join(workspace, 'old.txt'));
      writeFileSync(file, 'replacement');
      assert.equal((await registry.setPath(project.id, fileAlias, 'deny')).id, saved.id);
      assert.equal((await registry.preview(project.id)).paths.length, 1);
    } else {
      t.diagnostic('Verified distinct case-sensitive entries on the native filesystem.');
      mkdirSync(directoryAlias);
      assert.notEqual((await registry.addProject(directoryAlias)).id, project.id);
      linkSync(file, fileAlias);
      await assert.rejects(() => registry.setPath(project.id, fileAlias, 'deny'), /already registered under another path/);
      assert.deepEqual((await registry.preview(project.id)).paths, [saved]);
    }
  } finally {
    registry.close();
  }
});

test('a competing writer cannot rebind or delete the project between its final read and path save', async t => {
  const { workspace, file, state } = setup(t);
  const registry = new ProjectRegistry(state);
  const competitor = new DatabaseSync(join(state, 'projects.sqlite'));
  try {
    const project = await registry.addProject(workspace);
    competitor.exec('PRAGMA busy_timeout=0');
    const rebind = competitor.prepare('UPDATE projects SET identity=? WHERE id=?');
    const remove = competitor.prepare('DELETE FROM projects WHERE id=?');
    let projectReads = 0;
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
      const statement = prepare.call(this, sql);
      if (this === competitor || sql !== 'SELECT * FROM projects WHERE id=?') return statement;
      return {
        get(...args) {
          const row = statement.get(...args);
          // Force the competing write at the exact read/write boundary.
          if (++projectReads === 2) {
            assert.throws(() => rebind.run('new-project-identity', project.id), { errcode: 5 });
            assert.throws(() => remove.run(project.id), { errcode: 5 });
          }
          return row;
        }
      };
    });
    const saved = await registry.setPath(project.id, file, 'write');
    assert.equal(projectReads, 2);
    assert.equal(rebind.run('new-project-identity', project.id).changes, 1);
    assert.deepEqual((await registry.preview(project.id)).paths, [saved]);
  } finally {
    competitor.close();
    registry.close();
  }
});

for (const operation of ['rebind', 'delete']) {
  test(`a project ${operation} before the path write lock aborts the stale save`, async t => {
    const { workspace, file, state } = setup(t);
    const registry = new ProjectRegistry(state);
    const competitor = new DatabaseSync(join(state, 'projects.sqlite'), { enableForeignKeyConstraints: true });
    try {
      const project = await registry.addProject(workspace);
      const saved = await registry.setPath(project.id, file, 'read');
      const exec = DatabaseSync.prototype.exec;
      let raced = false;
      t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
        if (sql === 'BEGIN IMMEDIATE' && !raced) {
          raced = true;
          if (operation === 'rebind') {
            competitor.prepare('UPDATE projects SET identity=? WHERE id=?').run('new-project-identity', project.id);
          } else {
            competitor.prepare('DELETE FROM projects WHERE id=?').run(project.id);
          }
        }
        return exec.call(this, sql);
      });
      await assert.rejects(() => registry.setPath(project.id, file, 'write'), {
        code: 'INVALID_ARGUMENT',
        message: operation === 'rebind' ? /Project registration changed/ : /Project not found/
      });
      assert.equal(raced, true);
      const rows = competitor.prepare('SELECT id, access FROM project_paths WHERE project_id=?').all(project.id);
      assert.deepEqual(rows.map(row => ({ ...row })), operation === 'rebind' ? [{ id: saved.id, access: 'read' }] : []);
      const current = await registry.addProject(workspace);
      assert.equal((await registry.setPath(current.id, file, 'write')).access, 'write');
    } finally {
      competitor.close();
      registry.close();
    }
  });
}

test('a newer project schema remains intact and separate from fixture state', t => {
  const { state } = setup(t);
  new ProjectRegistry(state).close();
  const db = new DatabaseSync(join(state, 'projects.sqlite'));
  try {
    db.exec('PRAGMA user_version=99');
    assert.throws(() => new ProjectRegistry(state), { code: 'SCHEMA_TOO_NEW' });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
    new Store(state).close();
  } finally {
    db.close();
  }
});
