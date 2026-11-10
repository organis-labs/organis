import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const apps = ['cli', 'desktop'];
const shaPattern = /^[a-f0-9]{40}$/;
const require = createRequire(import.meta.url);
const docsOnly = file => file.startsWith('docs/') || /^[^/]+\.md$/i.test(file);

// App version bumps are release bookkeeping, not a change to both applications.
// Dependency versions, root/runtime versions and every other lock field remain inputs.
export function versionOnly(file, before, after) {
  if (!['apps/cli/package.json', 'apps/desktop/package.json', 'package-lock.json'].includes(file)) return false;
  try {
    const normalize = text => {
      const value = JSON.parse(text);
      if (file === 'package-lock.json') {
        for (const app of apps) if (value.packages?.[`apps/${app}`]) delete value.packages[`apps/${app}`].version;
      } else delete value.version;
      return value;
    };
    return isDeepStrictEqual(normalize(before), normalize(after));
  } catch { return false; }
}

export function conservativeApps(files) {
  const selected = new Set();
  for (const file of files) {
    if (docsOnly(file)) continue;
    if (file.startsWith('apps/cli/')) selected.add('cli');
    else if (file.startsWith('apps/desktop/') || file.startsWith('build/') || file === 'electron-builder.config.cjs') selected.add('desktop');
    else for (const app of apps) selected.add(app);
  }
  return [...selected].sort();
}

export function planAffected({ base, head, cwd = process.cwd(), invoke = spawnSync }) {
  const fallback = reason => ({ schemaVersion: 1, base, head, apps: [...apps], reason });
  function run(command, args) {
    const result = invoke(command, args, { cwd, env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
      encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('Affected command failed');
    return result.stdout;
  }
  if (!shaPattern.test(base ?? '') || !shaPattern.test(head ?? '')) return fallback('missing-or-invalid-baseline');
  try {
    if (run('git', ['rev-parse', 'HEAD']).trim() !== head) return fallback('checkout-head-mismatch');
    if (run('git', ['rev-parse', '--is-shallow-repository']).trim() !== 'false') return fallback('shallow-history');
    run('git', ['merge-base', '--is-ancestor', base, head]);
    const files = run('git', ['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean);
    const changed = files.filter(file => {
      if (docsOnly(file)) return false;
      if (!['apps/cli/package.json', 'apps/desktop/package.json', 'package-lock.json'].includes(file)) return true;
      try { return !versionOnly(file, run('git', ['show', `${base}:${file}`]), run('git', ['show', `${head}:${file}`])); }
      catch { return true; }
    });
    if (!changed.length) return { schemaVersion: 1, base, head, apps: [], reason: 'no-product-changes' };
    // Nx accepts a comma-separated file list. Ambiguous filenames must never omit work.
    if (changed.some(file => /[,\r\n]/.test(file))) return fallback('unsupported-filename');
    const packagePath = require.resolve('nx/package.json');
    const nx = JSON.parse(readFileSync(packagePath, 'utf8'));
    const executable = resolve(dirname(packagePath), nx.bin.nx);
    const affected = JSON.parse(run(process.execPath, [executable, 'show', 'projects', '--affected',
      '--with-target', 'build', '--files', changed.join(','), '--json']));
    if (!Array.isArray(affected) || affected.some(app => !apps.includes(app))) return fallback('unexpected-project-graph');
    // Root/unmapped changes cannot disappear merely because Nx has no owner for them.
    const selected = new Set([...affected, ...conservativeApps(changed)]);
    return { schemaVersion: 1, base, head, apps: [...selected].sort(), reason: 'nx-and-conservative-graph' };
  } catch { return fallback('unavailable-history-or-project-graph'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (['--base', '--head'].includes(args[i]) && i + 1 < args.length) {
      const key = args[i].slice(2);
      options[key] = args[++i];
    }
    else throw new Error('Usage: affected.mjs --base <sha> --head <sha> --json');
  }
  console.log(JSON.stringify(planAffected(options)));
}
