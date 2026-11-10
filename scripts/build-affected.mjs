import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { planAffected, workingTreeApps } from './affected.mjs';

const options = { base: 'origin/main', head: 'HEAD', dryRun: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') { options.dryRun = true; continue; }
  const match = /^--(base|head)(?:=(.*))?$/.exec(args[i]);
  if (!match) throw new Error('Usage: build-affected.mjs [--base <ref>] [--head <ref>] [--dry-run]');
  const value = match[2] ?? args[++i];
  if (!value || value.startsWith('-')) throw new Error('Expected a Git commit reference');
  options[match[1]] = value;
}
function commit(ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout.trim())) throw new Error(`Cannot resolve affected Git reference: ${ref}`);
  return result.stdout.trim();
}
const head = commit(options.head);
if (head !== commit('HEAD')) throw new Error('Build the checked-out HEAD; switch checkouts before selecting another head');
const plan = planAffected({ base: commit(options.base), head });
const localApps = workingTreeApps();
plan.apps = [...new Set([...plan.apps, ...localApps])].sort();
if (localApps.length) plan.reason += '+working-tree';
console.log(JSON.stringify(plan));
if (!options.dryRun && plan.apps.length) {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('nx/package.json');
  const executable = resolve(dirname(packagePath), JSON.parse(readFileSync(packagePath, 'utf8')).bin.nx);
  const result = spawnSync(process.execPath, [executable, 'run-many', '-t', 'build',
    `--projects=${plan.apps.join(',')}`, '--parallel=1'], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
