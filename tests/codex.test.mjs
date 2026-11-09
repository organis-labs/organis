import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexChecker, codexEnvironment, resolveCodex } from '../packages/runtime/src/codex.mjs';

const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../apps/cli/src/main.mjs', import.meta.url));
function checker(mode, options = {}) {
  const children = [];
  const check = createCodexChecker({ resolve: async () => process.execPath, timeoutMs: 4000, closeMs: 500,
    launch: (file, args, launchOptions) => {
      assert.equal(launchOptions.shell, false);
      assert.equal(launchOptions.windowsHide, true);
      const child = spawn(file, [fixture, mode, options.record ?? '-', ...args], launchOptions);
      children.push(child);
      return child;
    }, ...options });
  return { check, children };
}

test('connection check uses only discovery RPCs, redacts account data and closes both processes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'organis-codex-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = path.join(directory, 'requests.json');
  const { check, children } = checker('ready', { record });
  const result = await check();
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.164.0');
  assert.equal(result.capabilities.taskExecution, false);
  assert.deepEqual(result.authentication, { status: 'signed-in', kind: 'chatgpt' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|email|planType/);
  const evidence = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual(evidence.requests, ['initialize', 'initialized', 'account/read', ...(process.platform === 'win32' ? ['windowsSandbox/readiness'] : [])]);
  assert.ok(evidence.args.includes('hooks'));
  for (const name of evidence.envNames) assert.doesNotMatch(name, /^(OPENAI_API_KEY|GH_TOKEN|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|LD_PRELOAD)$/i);
  assert.equal(children.length, 2);
  for (const child of children) assert.equal(child.exitCode, 0);
});

for (const [mode, code] of [
  ['unsupported', 'CODEX_VERSION_UNSUPPORTED'], ['version-failed', 'CODEX_START_FAILED'], ['signed-out', 'CODEX_AUTH_REQUIRED'],
  ['unknown-auth', 'CODEX_AUTH_UNKNOWN'], ['malformed', 'CODEX_PROTOCOL_ERROR'],
  ['oversized', 'CODEX_PROTOCOL_ERROR'], ['rpc-error', 'CODEX_PROTOCOL_ERROR'], ['exit-error', 'CODEX_EXIT_FAILED']
]) {
  test(`Codex ${mode} is actionable and cannot report success`, async () => {
    const { check, children } = checker(mode);
    const result = await check();
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    if (mode === 'signed-out') assert.equal(result.authentication.status, 'signed-out');
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null);
    if (mode === 'unsupported') assert.equal(children.length, 1);
  });
}
test('timeout and cancellation close only owned check processes', async () => {
  for (const cancelled of [false, true]) {
    const abort = new AbortController();
    const { check, children } = checker('timeout', { timeoutMs: 450 });
    const timer = cancelled ? setTimeout(() => abort.abort(), 300) : null;
    const result = await check({ signal: abort.signal });
    clearTimeout(timer);
    assert.equal(result.code, cancelled ? 'CODEX_CHECK_CANCELLED' : 'CODEX_CHECK_TIMEOUT');
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
});
test('unconfigured Windows sandbox is actionable on every native test runner', async () => {
  const { check, children } = checker('sandbox-missing', { platform: 'win32' });
  const result = await check();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CODEX_SANDBOX_REQUIRED');
  assert.equal(result.sandbox, 'notConfigured');
  for (const child of children) assert.equal(child.exitCode, 0);
});
test('pre-cancelled check never launches a process', async () => {
  const { check, children } = checker('ready');
  const result = await check({ signal: AbortSignal.abort() });
  assert.equal(result.code, 'CODEX_CHECK_CANCELLED');
  assert.equal(children.length, 0);
});
test('a hung version command cannot outlive the deadline even when it ignores SIGTERM', async () => {
  const { check, children } = checker('version-timeout', { timeoutMs: 500 });
  assert.equal((await check()).code, 'CODEX_CHECK_TIMEOUT');
  assert.equal(children.length, 1);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
});
test('environment excludes secrets and interpreter injection while retaining Codex-owned home', () => {
  assert.deepEqual(codexEnvironment({ Path: 'path', HOME: 'home', CODEX_HOME: 'codex', SYSTEMROOT: 'windows',
    OPENAI_API_KEY: 'secret', GH_TOKEN: 'secret', NODE_OPTIONS: '--import evil', ELECTRON_RUN_AS_NODE: '1', LD_PRELOAD: 'evil' }),
  { Path: 'path', HOME: 'home', CODEX_HOME: 'codex', SYSTEMROOT: 'windows' });
});
test('discovery ignores relative PATH entries and rejects missing paths and Windows command shims', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'organis-codex-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(resolveCodex({ env: { PATH: '.' } }), { code: 'CODEX_NOT_FOUND' });
  await assert.rejects(resolveCodex({ executable: 'codex' }), { code: 'CODEX_EXECUTABLE_INVALID' });
  if (process.platform === 'win32') {
    const shim = path.join(directory, 'codex.cmd');
    await writeFile(shim, '@echo secret');
    await assert.rejects(resolveCodex({ executable: shim }), { code: 'CODEX_SHIM_UNSUPPORTED' });
  } else {
    const executable = path.join(directory, 'codex');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    assert.equal(await resolveCodex({ env: { PATH: directory } }), await realpath(executable));
  }
});
test('CLI connection errors are one JSON record and unknown arguments fail before discovery', () => {
  const result = spawnSync(process.execPath, [cli, 'agent', 'codex', 'check', '--executable', path.join(tmpdir(), 'missing-codex.exe'), '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, 'CODEX_EXECUTABLE_INVALID');
  assert.equal(result.stderr, '');
  const invalid = spawnSync(process.execPath, [cli, 'agent', 'codex', 'check', '--unknown', '--json'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stderr).code, 'INVALID_ARGUMENT');
  assert.equal(invalid.stdout, '');
});
