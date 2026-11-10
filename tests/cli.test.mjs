import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { version } from '../apps/cli/src/version.mjs';

const entry = fileURLToPath(new URL('../apps/cli/src/main.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
test('CLI reports version without Electron or network access', () => {
  const result = run('--version');
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), version);
});
test('status JSON distinguishes fixture execution from agent integration', () => {
  const result = run('status', '--json');
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {name:'Organis',version,stage:'local-execution-foundation',platform:process.platform,arch:process.arch,runtime:process.version,agentRuntimeAvailable:false,fixtureExecutionAvailable:true,codexConnectionCheckAvailable:true});
});
test('invalid commands fail instead of claiming to execute an agent', () => {
  for (const args of [['run'], ['status', '--unknown'], ['--version', 'extra']]) {
    const result = run(...args); assert.equal(result.status, 2); assert.match(result.stderr, /Unknown command/);
  }
});

test('root and command help explain Codex compatibility without running a check', t => {
  const root = run('--help');
  assert.equal(root.status, 0);
  assert.match(root.stdout, /organis agent codex check --help/);
  assert.match(root.stdout, /Codex connection checks support /);
  for (const args of [['agent', 'codex', 'check', '--help'], ['help', 'agent', 'codex', 'check']]) {
    const result = run(...args);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Supported Codex CLI: /);
    assert.match(result.stdout, /--executable <absolute-path>/);
    assert.match(result.stdout, /codex login/);
    assert.match(result.stdout, /does not run a task/);
    assert.match(result.stdout, /docs\/cli\.md/);
  }
  assert.equal(run('help', 'agent', 'unknown').status, 2);
  assert.equal(run('help', '--help').stdout, root.stdout);
  const folder = mkdtempSync(join(tmpdir(), 'organis-help-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const missing = join(folder, 'missing-codex');
  const codex = run('agent', 'codex', 'check', '--json', '--executable', missing, '--help');
  assert.equal(codex.status, 0, codex.stderr);
  assert.match(codex.stdout, /Supported Codex CLI:/);
  const state = join(folder, 'state');
  const fixture = run('run', 'fixture', '--workspace', folder, '--state-dir', state, '-h');
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.match(fixture.stdout, /organis run fixture/);
  assert.equal(existsSync(state), false);
  const unknown = run('agent', 'codex', 'unknown', '--help');
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /Unknown help topic/);
});
