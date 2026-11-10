import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workingTreeApps } from '../scripts/affected.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'organis-local-affected-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=' + join(cwd, '.git/no-hooks'), ...args],
      { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(file, content) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  }
  git('init', '--quiet');
  for (const file of ['apps/cli/src/main.mjs', 'apps/desktop/main.cjs', 'packages/runtime/src/main.mjs', 'docs/guide.md']) {
    write(file, 'original\n');
  }
  write('apps/cli/package.json', '{"version":"1","dependencies":{"example":"1"}}');
  write('package-lock.json', '{"packages":{"apps/cli":{"version":"1"}}}');
  write('.gitignore', 'dist/\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'fixture');
  return { cwd, git, write, plan: () => workingTreeApps({ cwd }) };
}

test('local planning includes unstaged, staged and untracked product inputs', t => {
  const f = fixture(t);
  assert.deepEqual(f.plan(), []);
  f.write('apps/cli/src/main.mjs', 'edited\n');
  assert.deepEqual(f.plan(), ['cli']);
  f.git('add', 'apps/cli/src/main.mjs');
  assert.deepEqual(f.plan(), ['cli']);
  // Index and disk changes cancel relative to HEAD, but both layers are inspected.
  f.write('apps/cli/src/main.mjs', 'original\n');
  assert.deepEqual(f.plan(), ['cli']);
  f.write('apps/desktop/new-\uD55C\uAE00.cjs', 'new\n');
  assert.deepEqual(f.plan(), ['cli', 'desktop']);
});

test('local docs, ignored output and version-only bookkeeping do not select apps', t => {
  const f = fixture(t);
  f.write('docs/guide.md', 'edited\n');
  f.write('docs/new.md', 'new\n');
  f.write('README.MD', 'new\n');
  f.write('dist/output', 'generated\n');
  f.write('apps/cli/package.json', '{"version":"2","dependencies":{"example":"1"}}');
  f.write('package-lock.json', '{"packages":{"apps/cli":{"version":"2"}}}');
  assert.deepEqual(f.plan(), []);
  f.git('add', 'apps/cli/package.json', 'package-lock.json', 'docs/guide.md');
  assert.deepEqual(f.plan(), []);
  f.write('apps/cli/package.json', '{"version":"3","dependencies":{"example":"1"}}');
  assert.deepEqual(f.plan(), []);
  f.write('apps/cli/package.json', '{"version":"3","dependencies":{"example":"2"}}');
  assert.deepEqual(f.plan(), ['cli']);
  f.write('package-lock.json', '{"packages":{"apps/cli":{"version":"2","dependencies":{"example":"2"}}}}');
  assert.deepEqual(f.plan(), ['cli', 'desktop']);
});

test('local renames, deletions, shared inputs and unknown paths are conservative', t => {
  const f = fixture(t);
  renameSync(join(f.cwd, 'apps/cli/src/main.mjs'), join(f.cwd, 'apps/desktop/moved.cjs'));
  assert.deepEqual(f.plan(), ['cli', 'desktop']);
  f.git('add', '-A');
  assert.deepEqual(f.plan(), ['cli', 'desktop']);
  const shared = fixture(t);
  rmSync(join(shared.cwd, 'packages/runtime/src/main.mjs'));
  assert.deepEqual(shared.plan(), ['cli', 'desktop']);
  const unknown = fixture(t);
  unknown.write('unmapped-input', 'new\n');
  assert.deepEqual(unknown.plan(), ['cli', 'desktop']);
});

test('local command selects dirty CLI with base equal to HEAD and rejects another head', t => {
  const f = fixture(t);
  const initial = f.git('rev-parse', 'HEAD');
  const script = fileURLToPath(new URL('../scripts/build-affected.mjs', import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath, [script, '--dry-run', ...args],
    { cwd: f.cwd, encoding: 'utf8', windowsHide: true });
  f.write('apps/cli/src/main.mjs', 'edited\n');
  const local = invoke('--base', 'HEAD');
  assert.equal(local.status, 0, local.stderr);
  assert.deepEqual(JSON.parse(local.stdout).apps, ['cli']);
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'second');
  const mismatch = invoke('--base', initial, '--head', initial);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Build the checked-out HEAD/);
});

test('failed local Git inspection never skips a potentially affected app', () => {
  assert.deepEqual(workingTreeApps({ invoke: () => ({ status: 1, stdout: '' }) }), ['cli', 'desktop']);
});
