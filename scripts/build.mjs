import { cp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { create as tar } from 'tar';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const meta = JSON.parse(await readFile('package.json', 'utf8'));
const platform = process.platform;
const arch = process.arch;
if (!['win32-x64', 'linux-x64', 'darwin-arm64'].includes(`${platform}-${arch}`)) throw new Error(`Unsupported native target: ${platform}-${arch}`);
if (process.versions.node !== meta.engines.node) throw new Error(`Use Node ${meta.engines.node}`);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const sourceSha = run('git', ['rev-parse', 'HEAD']);
if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid Git source commit');
if (process.env.ORGANIS_SOURCE_SHA && process.env.ORGANIS_SOURCE_SHA !== sourceSha) throw new Error('Source SHA mismatch');
const sourceDirty = run('git', ['status', '--porcelain']).length > 0;
if (process.env.CI && sourceDirty) throw new Error('CI builds require a clean source checkout');
for (const path of ['apps/cli/package.json','apps/desktop/package.json','packages/runtime/package.json']) {
  if (JSON.parse(await readFile(path, 'utf8')).version !== meta.version) throw new Error(`Version mismatch: ${path}`);
}
const target = `${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'}-${arch}`;
const staging = join(root, '.build', target);
const output = join(root, 'dist', target);
await rm(staging, {recursive: true, force: true});
await rm(output, {recursive: true, force: true});
await mkdir(staging, {recursive: true});
await mkdir(output, {recursive: true});
const cliName = `organis-cli-${meta.version}-${target}`;
const cliDir = join(staging, cliName);
await mkdir(cliDir, {recursive: true});
for (const path of ['apps/cli', 'packages/runtime']) await cp(join(root, path), join(cliDir, path), {recursive: true});
const nodeName = platform === 'win32' ? 'node.exe' : 'node';
await cp(process.execPath, join(cliDir, nodeName));
await chmod(join(cliDir, nodeName), 0o755);
const nodeLicense = await readFile('NODE-LICENSE.txt');
if (createHash('sha256').update(nodeLicense).digest('hex') !== '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace') throw new Error('Pinned Node license mismatch');
await writeFile(join(cliDir, 'NODE-LICENSE.txt'), nodeLicense);
if (platform === 'win32') {
  await writeFile(join(cliDir, 'organis.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0apps\\cli\\src\\main.mjs" %*\r\nexit /b %errorlevel%\r\n');
} else {
  await writeFile(join(cliDir, 'organis'), '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/node" "$base/apps/cli/src/main.mjs" "$@"\n');
  await chmod(join(cliDir, 'organis'), 0o755);
}
const cliResult = JSON.parse(run(join(cliDir, nodeName), [join(cliDir, 'apps/cli/src/main.mjs'), 'status', '--json']));
if (cliResult.version !== meta.version || cliResult.platform !== platform || cliResult.arch !== arch) throw new Error('Packaged CLI smoke failed');
const [desktopDir] = await packager({
  dir: join(root, 'apps/desktop'), out: staging, name: 'Organis', platform, arch,
  electronVersion: meta.devDependencies.electron, appVersion: meta.version,
  appBundleId: 'org.organislabs.organis', asar: true, overwrite: true, prune: true
});
const executable = platform === 'win32' ? join(desktopDir, 'Organis.exe') :
  platform === 'darwin' ? join(desktopDir, 'Organis.app/Contents/MacOS/Organis') : join(desktopDir, 'Organis');
const smokeEnv = {...process.env};
delete smokeEnv.ELECTRON_RUN_AS_NODE;
if (platform === 'linux') delete smokeEnv.WAYLAND_DISPLAY;
const smokeResult = run(platform === 'linux' ? 'xvfb-run' : executable,
  platform === 'linux' ? ['-a', executable, '--ozone-platform=x11', '--smoke-test'] : ['--smoke-test'],
  {env: smokeEnv, timeout: 45000});
if (!smokeResult.includes('ORGANIS_DESKTOP_SMOKE_OK')) throw new Error('Desktop renderer smoke marker missing');
async function archive(directory, name) {
  const extension = platform === 'win32' ? '.zip' : '.tar.gz';
  const destination = join(output, name + extension);
  if (platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:ORGANIS_ARCHIVE_SOURCE, $env:ORGANIS_ARCHIVE_DEST, [System.IO.Compression.CompressionLevel]::Optimal, $true)'],
      {env: {...process.env, ORGANIS_ARCHIVE_SOURCE: directory, ORGANIS_ARCHIVE_DEST: destination}});
  } else {
    await tar({gzip: true, file: destination, cwd: dirname(directory)}, [basename(directory)]);
  }
  const bytes = await readFile(destination);
  return {file: name + extension, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
}
const files = [await archive(cliDir, cliName), await archive(desktopDir, `organis-desktop-${meta.version}-${target}`)];
const manifest = {
  schemaVersion: 1, product: 'Organis', version: meta.version,
  source: {repository: 'organis-labs/organis', sha: sourceSha, dirty: sourceDirty},
  target, platform, arch, node: process.versions.node, electron: meta.devDependencies.electron,
  lockfileSha256: createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),
  builtAt: new Date().toISOString(), signed: false,
  smoke: {cli: true, desktopRenderer: true},
  workflow: process.env.GITHUB_RUN_ID ? {repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT} : null,
  files
};
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(output, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.file}`).join('\n') + '\n');
console.log(JSON.stringify(manifest, null, 2));
