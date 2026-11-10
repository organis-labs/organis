import { spawnSync } from 'node:child_process';

const apps = JSON.parse(process.argv[2] ?? 'null');
if (!Array.isArray(apps) || apps.length > 2 || new Set(apps).size !== apps.length
    || apps.some(app => !['cli', 'desktop'].includes(app))) throw new Error('Invalid affected application list');
for (const app of apps) {
  const result = spawnSync(process.execPath, ['scripts/build.mjs', '--verify-only', '--app', app],
    { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!apps.length) console.log('No affected applications; native packaging skipped.');
