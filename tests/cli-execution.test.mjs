import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { smokeCLI } from '../scripts/smoke-cli.mjs';

const entry = fileURLToPath(new URL('../apps/cli/src/main.mjs', import.meta.url));
test('source CLI completes, persists, deduplicates, cancels and reports failure without a display', async () => {
  assert.equal((await smokeCLI(process.execPath, entry)).headless, true);
});

test('another CLI process requests cancellation and observes confirmed termination', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'organis-cli-cancel-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const common = ['--state-dir', join(root, 'state'), '--json'];
  const child = spawn(process.execPath, [entry, 'run', 'fixture', '--workspace', workspace, '--mode', 'wait', ...common], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    const deadline = Date.now() + 15000;
    while (!stdout.includes('\n') && child.exitCode === null && Date.now() < deadline) await delay(25);
    assert.ok(stdout.includes('\n'), `Missing acknowledgement: ${stderr}`);
    const accepted = JSON.parse(stdout.split('\n')[0]);
    const cancelled = spawnSync(process.execPath, [entry, 'run', 'cancel', accepted.run.id, ...common], {
      encoding: 'utf8', timeout: 10000, windowsHide: true
    });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.ok(['cancelling', 'cancelled'].includes(JSON.parse(cancelled.stdout).run.state));
    assert.equal(await closed, 130, stderr);
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.run.state, 'cancelled');
    const inspected = spawnSync(process.execPath, [entry, 'run', 'show', accepted.run.id, ...common], { encoding: 'utf8', timeout: 10000 });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).run.state, 'cancelled');
  } finally {
    if (child.exitCode === null) child.kill();
    await closed.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI refuses malformed controls and unsupported sandbox scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'organis-cli-deny-'));
  try {
    for (const args of [
      ['fixture', '--workspace', root, '--scope', 'os-sandbox'],
      ['fixture', '--workspace', root, '--duration', '-1'],
      ['fixture', '--workspace', root, '--unexpected'],
      ['events', 'missing', '--after', '1.5']
    ]) {
      const result = spawnSync(process.execPath, [entry, 'run', ...args, '--state-dir', join(root, 'state'), '--json'], {
        encoding: 'utf8', timeout: 10000, windowsHide: true
      });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).type, 'error');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interrupting a duplicate observer leaves the original owner running', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'organis-cli-observer-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const common = ['--state-dir', join(root, 'state'), '--json'];
  const request = [entry, 'run', 'fixture', '--workspace', workspace, '--mode', 'wait', '--command-id', randomUUID(), ...common];
  const children = [];
  async function start() {
    const child = spawn(process.execPath, request, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let output = '';
    let errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors += bytes; });
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    children.push({ child, closed });
    const deadline = Date.now() + 10000;
    while (!output.includes('\n') && child.exitCode === null && Date.now() < deadline) await delay(25);
    assert.ok(output.includes('\n'), errors);
    return { child, closed, accepted: JSON.parse(output.split('\n')[0]) };
  }
  try {
    const owner = await start();
    const observer = await start();
    assert.equal(observer.accepted.duplicate, true);
    observer.child.send({ type: 'organis:interrupt' });
    assert.equal(await observer.closed, 130);
    const result = spawnSync(process.execPath, [entry, 'run', 'show', owner.accepted.run.id, ...common], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).run.state, 'running');
    owner.child.send({ type: 'organis:interrupt' });
    assert.equal(await owner.closed, 130);
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(({ closed }) => closed.catch(() => {})));
    rmSync(root, { recursive: true, force: true });
  }
});
