import test from 'node:test';
import assert from 'node:assert/strict';
import { conservativeApps, planAffected, versionOnly } from '../scripts/affected.mjs';

test('release bookkeeping ignores only application version fields', () => {
  const old = { lockfileVersion: 3, version: 'root', packages: { 'apps/cli': { version: '1', dependencies: { tar: '7' } }, '': { version: 'root' } } };
  const next = structuredClone(old);
  next.packages['apps/cli'].version = '2';
  assert.equal(versionOnly('package-lock.json', JSON.stringify(old), JSON.stringify(next)), true);
  next.packages['apps/cli'].dependencies.tar = '8';
  assert.equal(versionOnly('package-lock.json', JSON.stringify(old), JSON.stringify(next)), false);
  assert.equal(versionOnly('apps/cli/package.json', '{"version":"1"}', '{"version":"2"}'), true);
  assert.equal(versionOnly('package.json', '{"version":"1"}', '{"version":"2"}'), false);
  assert.equal(versionOnly('packages/runtime/package.json', '{"version":"1"}', '{"version":"2"}'), false);
  assert.equal(versionOnly('package-lock.json', 'bad', '{}'), false);
});

test('conservative paths never drop shared, global or unknown build inputs', () => {
  assert.deepEqual(conservativeApps(['docs/roadmap.md', 'README.md']), []);
  assert.deepEqual(conservativeApps(['apps/cli/src/update.mjs']), ['cli']);
  assert.deepEqual(conservativeApps(['apps/desktop/main.cjs', 'build/icon.png']), ['desktop']);
  for (const file of ['packages/runtime/src/execution.mjs', 'new-unmapped-input', '.npmrc', '.github/workflows/verify.yml']) {
    assert.deepEqual(conservativeApps([file]), ['cli', 'desktop']);
  }
});

test('missing history, checkout mismatch and shallow history select both apps', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  assert.deepEqual(planAffected({ base: '', head }).apps, ['cli', 'desktop']);
  assert.deepEqual(planAffected({ base, head, invoke: () => ({ status: 1, stdout: '' }) }).apps, ['cli', 'desktop']);
  assert.equal(planAffected({ base, head, invoke: () => ({ status: 0, stdout: base }) }).reason, 'checkout-head-mismatch');
  assert.equal(planAffected({ base, head, invoke: (_, args) => ({ status: 0, stdout: args.includes('HEAD') ? head : 'true' }) }).reason, 'shallow-history');
});

test('a docs-only comparison is a no-op without executing Nx', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const plan = planAffected({ base, head, invoke: (command, args) => {
    assert.equal(command, 'git');
    return { status: 0, stdout: args.includes('HEAD') ? head : args.includes('--is-shallow-repository') ? 'false'
      : args.includes('--name-only') ? 'docs/roadmap.md\0README.md\0' : '' };
  } });
  assert.deepEqual(plan.apps, []);
});
