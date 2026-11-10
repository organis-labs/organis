import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = fileURLToPath(new URL('../node_modules/nx/dist/bin/nx.js', import.meta.url));
function affected(file) {
  const result = spawnSync(process.execPath, [executable, 'show', 'projects', '--affected',
    '--with-target', 'build', '--files', file, '--json'], {
    cwd: root, env: { ...process.env, NX_DAEMON: 'false' }, encoding: 'utf8', timeout: 30000
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout).sort();
}

test('Nx affected preserves application and shared dependency boundaries', () => {
  const cases = [
    ['docs/roadmap.md', []],
    ['apps/cli/src/main.mjs', ['cli']],
    ['apps/desktop/main.cjs', ['desktop']],
    ['packages/runtime/src/execution.mjs', ['cli', 'desktop']],
    ['electron-builder.config.cjs', ['desktop']],
    ['package-lock.json', ['cli', 'desktop']],
    ['NODE-LICENSE.txt', ['cli', 'desktop']],
    ['.github/workflows/verify.yml', ['cli', 'desktop']]
  ];
  for (const [file, expected] of cases) assert.deepEqual(affected(file), expected, file);
});
