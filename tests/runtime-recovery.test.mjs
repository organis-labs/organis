import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalRuntime } from '../packages/runtime/src/execution.mjs';
import { killOwnedTree, pidAlive } from '../packages/runtime/src/process-tree.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'organis-recovery-'));
  const stateDir = join(root, 'state');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const runtime = new LocalRuntime({ stateDir });
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, stateDir, workspace };
}

test('cancellation during startup includes identities delivered after the request', { timeout: 20000 }, async t => {
  const { runtime, workspace } = setup(t);
  const { run } = await runtime.startFixture({ workspace, mode: 'wait' });
  await new Promise(setImmediate);
  await runtime.cancel(run.id);
  const final = await runtime.wait(run.id, { timeoutMs: 15000 });
  assert.equal(final.state, 'cancelled');
  const ready = runtime.events(run.id).find(event => event.type === 'fixture_ready');
  assert.ok(ready, 'The spawned tree must report identities before cancellation is verified');
  // Windows may keep the exited process object visible briefly after the exit event.
  const reapedBy = Date.now() + 1000;
  while (pidAlive(ready.pid) && Date.now() < reapedBy) await delay(10);
  assert.equal(pidAlive(ready.pid), false);
  assert.equal(pidAlive(ready.grandchildPid), false);
});

test('an exited child handle never causes a recycled PID to be killed', async t => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const closed = new Promise(resolve => unrelated.once('close', resolve));
  t.after(async () => { unrelated.kill(); await closed; });
  await new Promise(resolve => unrelated.once('spawn', resolve));
  await killOwnedTree({ child: { pid: unrelated.pid, exitCode: 0, signalCode: null,
    kill: () => assert.fail('Exited process handle must not be signalled') }, grandchildPid: unrelated.pid });
  assert.equal(pidAlive(unrelated.pid), true);
});

test('an unverified descendant keeps the workspace leased after the direct child exits', { timeout: 20000 }, async t => {
  const { runtime, workspace } = setup(t);
  const { run } = await runtime.startFixture({ workspace, durationMs: 1000 });
  let ready;
  const deadline = Date.now() + 5000;
  while (!(ready = runtime.events(run.id).find(event => event.type === 'fixture_ready'))) {
    assert.ok(Date.now() < deadline, 'Fixture startup timed out');
    await delay(10);
  }
  const originalKill = process.kill;
  // Simulate the recorded grandchild PID remaining occupied after exit (PID reuse).
  process.kill = function(pid, signal) {
    if (pid === ready.grandchildPid && signal === 0) return true;
    return originalKill.call(process, pid, signal);
  };
  try {
    const final = await runtime.wait(run.id, { timeoutMs: 15000 });
    assert.equal(final.state, 'interrupted');
    assert.equal(final.errorCode, 'TERMINATION_UNVERIFIED');
    assert.equal(final.ownershipRetained, true);
    await assert.rejects(runtime.startFixture({ workspace }), { code: 'WORKSPACE_BUSY' });
  } finally { process.kill = originalKill; }
  runtime.reconcile();
  assert.equal(runtime.getRun(run.id).ownershipRetained, false);
});

test('a crash between launch intent and process identity never frees an uncertain workspace', async t => {
  const { runtime, stateDir, workspace } = setup(t);
  const { run } = await runtime.startFixture({ workspace, durationMs: 0 });
  await runtime.wait(run.id);
  await runtime.close();
  const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'));
  db.prepare("UPDATE runs SET state='queued',process_pid=NULL,grandchild_pid=NULL WHERE id=?").run(run.id);
  db.prepare('UPDATE workspaces SET busy_run_id=?').run(run.id);
  db.prepare("DELETE FROM events WHERE run_id=? AND type NOT IN ('run_created','launch_requested')").run(run.id);
  db.close();
  const recovered = new LocalRuntime({ stateDir });
  try {
    assert.equal(recovered.getRun(run.id).state, 'interrupted');
    assert.equal(recovered.getRun(run.id).ownershipRetained, true);
    recovered.reconcile();
    await assert.rejects(recovered.startFixture({ workspace }), { code: 'WORKSPACE_BUSY' });
    assert.equal(recovered.events(run.id).some(event => event.type === 'process_started'), false);
  } finally { await recovered.close(); }
});
