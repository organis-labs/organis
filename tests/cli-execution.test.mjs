import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { smokeCLI } from '../scripts/smoke-cli.mjs';

const entry = fileURLToPath(new URL('../apps/cli/src/main.mjs', import.meta.url));

for (const json of [false, true]) {
  test(`a failed interrupt cancellation is reported on stderr (${json ? 'JSON' : 'text'})`, { timeout: 20000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'organis-cli-cancel-error-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    // Inject only the failed request boundary; use the real CLI, runtime and fixture.
    const preload = `
      import { LocalRuntime } from ${JSON.stringify(new URL('../packages/runtime/src/execution.mjs', import.meta.url).href)};
      LocalRuntime.prototype.cancel = async () => {
        throw Object.assign(new Error('Injected persistence failure'), { code: 'PERSISTENCE_FAILED' });
      };
    `;
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      entry, 'run', 'fixture', '--workspace', workspace, '--duration', '1500', '--state-dir', join(root, 'state'),
      ...(json ? ['--json'] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    try {
      const deadline = Date.now() + 10000;
      while (!stdout.includes('"duplicate"') && child.exitCode === null && Date.now() < deadline) await delay(25);
      assert.ok(stdout.includes('"duplicate"'), `Missing acknowledgement: ${stderr}`);
      child.send({ type: 'organis:interrupt' });
      assert.equal(await closed, 0, stderr);
      assert.match(stderr, /Cancellation request failed: Injected persistence failure/);
      assert.match(stderr, /Press Ctrl\+C again to stop observing; termination is not confirmed/);
      if (json) {
        const errors = stderr.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
        assert.equal(errors.length, 1);
        assert.equal(errors[0].type, 'error');
        assert.equal(errors[0].code, 'PERSISTENCE_FAILED');
        const records = stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(records.map(record => record.type), ['accepted', 'result']);
        assert.equal(records.at(-1).run.state, 'completed');
      } else {
        assert.match(stderr, /PERSISTENCE_FAILED: Cancellation request failed/);
        assert.match(stdout, /"state": "completed"/);
      }
    } finally {
      if (child.exitCode === null) child.kill();
      await closed.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('source CLI completes, persists, deduplicates, cancels and reports failure without a display', async () => {
  assert.equal((await smokeCLI(process.execPath, entry)).headless, true);
});

test('a fresh CLI preserves deduplication and workspace ownership after the owner crashes before spawn', () => {
  const root = mkdtempSync(join(tmpdir(), 'organis-cli-crash-'));
  try {
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    mkdirSync(workspace);
    const commandId = randomUUID();
    const fixtureArgs = ['fixture', '--workspace', workspace];
    const request = [...fixtureArgs, '--command-id', commandId];
    const run = (args, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, entry, 'run', ...args,
      '--state-dir', stateDir, '--json'], { encoding: 'utf8', timeout: 10000, windowsHide: true });

    // Kill the CLI after launch intent commits but before the fixture starts.
    const fixtureEntry = fileURLToPath(new URL('../packages/runtime/src/fixture-process.mjs', import.meta.url));
    const crashBeforeSpawn = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const spawn = childProcess.spawn;
      childProcess.spawn = (...args) => {
        if (Array.isArray(args[1]) && args[1].includes(${JSON.stringify(fixtureEntry)})) process.kill(process.pid, 'SIGKILL');
        return spawn(...args);
      };
      syncBuiltinESMExports();
    `;
    const crashed = run(request, ['--import', `data:text/javascript,${encodeURIComponent(crashBeforeSpawn)}`]);
    assert.ifError(crashed.error);
    // A self-terminated Windows process is reported with exit status 1, not a signal.
    if (process.platform === 'win32') assert.equal(crashed.status, 1, crashed.stderr);
    else assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    // Check durable state before any recovery, since abrupt exit may truncate stdout.
    const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'), { readOnly: true });
    let original;
    try {
      original = db.prepare(`SELECT runs.id, runs.state, runs.process_pid, owners.closed_at
        FROM runs JOIN owners ON owners.id = runs.owner_id
        JOIN events ON events.run_id = runs.id AND events.type = 'launch_requested'
        WHERE runs.command_id = ?`).get(commandId);
    } finally { db.close(); }
    assert.ok(original, 'The crashed owner must have committed launch intent');
    assert.equal(original.state, 'queued');
    assert.equal(original.process_pid, null);
    assert.equal(original.closed_at, null);

    const retry = run(request);
    assert.equal(retry.status, 1, retry.error?.message ?? retry.stderr);
    const [accepted, result] = retry.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(accepted.type, 'accepted');
    assert.equal(accepted.duplicate, true);
    assert.equal(accepted.run.id, original.id);
    assert.equal(result.type, 'result');
    assert.equal(result.run.id, original.id);
    assert.equal(result.run.state, 'interrupted');
    assert.equal(result.run.errorCode, 'OWNER_LOST');
    assert.equal(result.run.ownershipRetained, true);
    assert.equal(result.run.processPid, null);

    const expectError = (args, code) => {
      const rejected = run(args);
      assert.equal(rejected.status, 1, rejected.error?.message ?? rejected.stderr);
      assert.equal(rejected.stdout, '');
      assert.equal(JSON.parse(rejected.stderr.trim().split('\n').at(-1)).code, code);
    };
    expectError([...request, '--mode', 'fail'], 'COMMAND_CONFLICT');
    expectError([...fixtureArgs, '--command-id', randomUUID()], 'WORKSPACE_BUSY');

    const listed = run(['list']);
    assert.equal(listed.status, 0, listed.error?.message ?? listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).runs.map(item => item.id), [original.id]);
    const history = run(['events', original.id]);
    assert.equal(history.status, 0, history.error?.message ?? history.stderr);
    const { events } = JSON.parse(history.stdout);
    assert.equal(events.filter(event => event.type === 'launch_requested').length, 1);
    assert.equal(events.some(event => event.type === 'process_started' || event.type === 'fixture_ready'), false);
    assert.equal(events.find(event => event.type === 'ownership_retained')?.reason, 'launch_identity_unverified');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
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
