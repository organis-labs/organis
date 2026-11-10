import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('project aliases resolve to one canonical directory and replacement requires a fresh registration', async t => {
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
    await assert.rejects(() => registry.setPath(project.id, file, 'deny'), /Remove the changed path/);
    registry.removePath(project.id, saved.id);
    assert.equal((await registry.setPath(project.id, file, 'deny')).status, 'available');
    const moved = join(root, 'old-project');
    renameSync(workspace, moved);
    await assert.rejects(() => registry.addProject(moved), /Remove the moved project/);
    mkdirSync(workspace);
    assert.equal((await registry.preview(project.id)).project.status, 'changed');
    await assert.rejects(() => registry.setPath(project.id, workspace, 'read'), /project directory.*changed/);
    await assert.rejects(() => registry.addProject(workspace), /Remove the changed project/);
  } finally {
    registry.close();
  }
});

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
