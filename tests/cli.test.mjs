import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
