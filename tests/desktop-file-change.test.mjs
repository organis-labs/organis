import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileChangeController } from '../apps/desktop/file-change.cjs';

const original = 'Original fixture content\n';
const replacement = 'Updated fixture content\n';
const root = await mkdtemp(path.join(os.tmpdir(), 'organis-file-change-'));
process.env.ORGANIS_TEST_CODEX_SCENARIO = 'desktop-file-change';
process.env.HOME = process.env.USERPROFILE = root;

test.after(() => rm(root, { recursive: true, force: true }));
await import('./fixtures/codex-run-preload.mjs');
const { LocalRuntime } = await import('../packages/runtime/src/execution.mjs');
const { ProjectRegistry } = await import('../packages/runtime/src/projects.mjs');

async function setup(t) {
  const base = await mkdtemp(path.join(root, 'case-'));
  const workspace = path.join(base, 'project');
  const stateDir = path.join(base, 'state');
  await mkdir(workspace);
  const registry = new ProjectRegistry(stateDir);
  const project = await registry.addProject(workspace);
  registry.close();
  const file = path.join(project.path, 'notes.txt');
  const other = path.join(project.path, 'other.txt');
  await writeFile(file, original);
  await writeFile(other, 'unchanged');
  const runtime = new LocalRuntime({ stateDir });
  const dialog = {
    async showOpenDialog() { return { canceled: false, filePaths: [file] }; },
    async showMessageBox(_window, { defaultId, cancelId, detail }) {
      assert.equal(defaultId, 0);
      assert.equal(cancelId, 0);
      assert.equal(detail, file);
      return { response: 1 };
    }
  };
  const controller = createFileChangeController({
    runtime, dialog, getWindow: () => ({}), getCodexExecutable: () => process.execPath
  });
  t.after(async () => {
    try { await controller.discard(); } finally { await runtime.close(); }
  });
  return {
    file, other, dialog, controller, project, runtime,
    propose: () => controller.start({ projectId: project.id, instructions: 'Update the first line.' }),
    async assertUnchanged() {
      assert.equal(await readFile(file, 'utf8'), original);
      assert.equal(await readFile(other, 'utf8'), 'unchanged');
      assert.deepEqual((await readdir(project.path)).sort(), ['notes.txt', 'other.txt']);
    }
  };
}

test('only the reviewed file changes after confirmation and approval cannot be replayed', async t => {
  const fixture = await setup(t);
  const proposal = await fixture.propose();
  assert.deepEqual(proposal, { id: proposal.id, target: fixture.file, original, replacement });
  await fixture.assertUnchanged();
  await assert.rejects(fixture.controller.approve('stale'), /no longer available/);
  assert.equal(await fixture.controller.approve(proposal.id), true);
  assert.equal(await readFile(fixture.file, 'utf8'), replacement);
  assert.equal(await readFile(fixture.other, 'utf8'), 'unchanged');
  assert.deepEqual((await readdir(fixture.project.path)).sort(), ['notes.txt', 'other.txt']);
  await assert.rejects(fixture.controller.approve(proposal.id), /no longer available/);
  const [run] = fixture.runtime.listRuns();
  await assert.rejects(fixture.runtime.applyCodexFileChange(run.id, { signal: new AbortController().signal }), /no longer available/);
  assert.equal(fixture.runtime.events(run.id).filter(event => event.type === 'codex_file_change_authorized').length, 1);
});

test('closing an unapproved proposal or cancelling the native confirmation leaves files unchanged', async t => {
  const fixture = await setup(t);
  const unapproved = await fixture.propose();
  await fixture.assertUnchanged();
  assert.equal(await fixture.controller.discard(), true);
  await assert.rejects(fixture.controller.approve(unapproved.id), /no longer available/);
  await fixture.assertUnchanged();

  const cancelled = await fixture.propose();
  fixture.dialog.showMessageBox = async () => ({ response: 0 });
  assert.equal(await fixture.controller.approve(cancelled.id), false);
  await assert.rejects(fixture.controller.approve(cancelled.id), /no longer available/);
  await fixture.assertUnchanged();
  assert(fixture.runtime.listRuns().every(run => fixture.runtime.events(run.id)
    .every(event => event.type !== 'codex_file_change_authorized')));
});

test('discard wins while confirmation is pending, even if the dialog then returns Apply', async t => {
  const fixture = await setup(t);
  const proposal = await fixture.propose();
  const confirm = Promise.withResolvers();
  fixture.dialog.showMessageBox = () => confirm.promise;
  const applying = fixture.controller.approve(proposal.id);
  await assert.rejects(fixture.controller.approve(proposal.id), /no longer available/);
  await fixture.controller.discard();
  confirm.resolve({ response: 1 });
  assert.equal(await applying, false);
  await fixture.assertUnchanged();
});

test('cancelling an active Codex proposal leaves both files unchanged', { timeout: 10000 }, async t => {
  const fixture = await setup(t);
  const pending = fixture.controller.start({ projectId: fixture.project.id, instructions: 'Wait for explicit cancellation' });
  let run;
  while (!run || !fixture.runtime.events(run.id).some(event => event.type === 'codex_turn_started')) {
    await delay(30, null, { signal: t.signal });
    [run] = fixture.runtime.listRuns();
  }
  assert.equal(await fixture.controller.discard(), true);
  assert.equal(await pending, null);
  assert.equal((await fixture.runtime.wait(run.id)).state, 'cancelled');
  await fixture.assertUnchanged();
});

test('a replacement of the target after preview invalidates approval even when its contents match', async t => {
  const fixture = await setup(t);
  const proposal = await fixture.propose();
  const substitute = path.join(fixture.project.path, 'replacement.txt');
  await writeFile(substitute, original);
  await rename(substitute, fixture.file);
  await assert.rejects(fixture.controller.approve(proposal.id), /original file changed/);
  await fixture.assertUnchanged();
});

test('a file outside the selected project is rejected before starting Codex', async t => {
  const fixture = await setup(t);
  const outside = path.join(path.dirname(fixture.project.path), 'outside.txt');
  await writeFile(outside, original);
  fixture.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outside] });
  await assert.rejects(fixture.propose(), /directly inside the registered project/);
  assert.deepEqual(fixture.runtime.listRuns(), []);
  assert.equal(await readFile(outside, 'utf8'), original);
  await fixture.assertUnchanged();
});

test('a target linked to a second path cannot be selected or changed', async t => {
  const fixture = await setup(t);
  const alias = path.join(path.dirname(fixture.project.path), 'alias.txt');
  await link(fixture.file, alias);
  await assert.rejects(fixture.propose(), /directly inside the registered project/);
  assert.deepEqual(fixture.runtime.listRuns(), []);
  assert.equal(await readFile(alias, 'utf8'), original);
  await unlink(alias);
  await fixture.assertUnchanged();
});
