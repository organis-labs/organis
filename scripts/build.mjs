import { cp, mkdir, readFile, writeFile, rm, chmod, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildDesktop } from 'electron-builder';
import { build as bundle } from 'esbuild';
import { create as tar } from 'tar';
import builderConfig from '../electron-builder.config.cjs';
import { signMac } from './mac-sign.mjs';
import { smokeCLI } from './smoke-cli.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const meta = JSON.parse(await readFile('package.json', 'utf8'));
const platform = process.platform;
const arch = process.arch;
const args = process.argv.slice(2);
const verificationOnly = args.includes('--verify-only');
let app = 'all';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--verify-only') continue;
  if (args[i] === '--app' && ['all', 'cli', 'desktop'].includes(args[i + 1])) { app = args[++i]; continue; }
  throw new Error('Usage: build.mjs [--verify-only] [--app all|cli|desktop]');
}
const includeCLI = app !== 'desktop';
const includeDesktop = app !== 'cli';
if (app !== 'all') meta.version = JSON.parse(await readFile(`apps/${app}/package.json`, 'utf8')).version;
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
for (const path of (app === 'all' ? ['apps/cli/package.json','apps/desktop/package.json'] : [`apps/${app}/package.json`])) {
  if (JSON.parse(await readFile(path, 'utf8')).version !== meta.version) throw new Error(`Version mismatch: ${path}`);
}
const target = `${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'}-${arch}`;
const staging = join(root, '.build', verificationOnly ? `verify-${app === 'all' ? '' : `${app}-`}${target}` : app === 'all' ? target : `${app}/${target}`);
const output = join(root, 'dist', verificationOnly ? `verify-${app === 'all' ? '' : `${app}-`}${target}` : app === 'all' ? target : `${app}/${target}`);
const desktopOutput = join(staging, 'desktop');
if (!/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(meta.version)) throw new Error('Release builds require a beta version such as 0.1.0-beta.1');
if (includeDesktop && !verificationOnly && platform === 'darwin' && !process.env.ORGANIS_MAC_SIGNING_IDENTITY) {
  throw new Error('macOS releases require ORGANIS_MAC_SIGNING_IDENTITY for an existing Developer ID Application identity');
}
if (includeDesktop && !verificationOnly && platform === 'darwin' && !process.env.ORGANIS_NOTARY_PROFILE) {
  throw new Error('macOS releases require ORGANIS_NOTARY_PROFILE for notarization');
}
await rm(staging, {recursive: true, force: true});
await rm(output, {recursive: true, force: true});
await mkdir(staging, {recursive: true});
await mkdir(output, {recursive: true});
let cliName, cliDir, cliExecution;
let signed = false;
let notarized = false;
if (includeCLI) {
cliName = `organis-cli-${meta.version}-${target}`;
cliDir = join(staging, cliName);
await mkdir(cliDir, {recursive: true});
for (const path of ['apps/cli', 'packages/runtime']) await cp(join(root, path), join(cliDir, path), {recursive: true});
await cp(join(root, 'apps/cli/bootstrap.cjs'), join(cliDir, 'bootstrap.cjs'));
await bundle({
  entryPoints: [join(root, 'apps/cli/src/update.mjs')],
  outfile: join(cliDir, 'apps/cli/src/update.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: {js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'}
});
// tar's published entry bundles its dependencies. Preserve their license texts
// alongside the standalone CLI updater instead of relying on minified comments.
const licenses = [];
for (const name of ['tar', '@isaacs/fs-minipass', 'chownr', 'minipass', 'minizlib', 'yallist']) {
  const directory = join(root, 'node_modules', name);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const license = (await readdir(directory)).find(file => /^license(?:\.md|\.txt)?$/i.test(file));
  if (!license) throw new Error(`Missing bundled dependency license: ${name}`);
  licenses.push(`${name}@${pkg.version} (${pkg.license})\n\n${await readFile(join(directory, license), 'utf8')}`);
}
await writeFile(join(cliDir, 'THIRD-PARTY-LICENSES.txt'), licenses.join('\n\n---\n\n'));
const nodeName = platform === 'win32' ? 'node.exe' : 'node';
await cp(process.execPath, join(cliDir, nodeName));
await chmod(join(cliDir, nodeName), 0o755);
const nodeLicense = await readFile('NODE-LICENSE.txt');
if (createHash('sha256').update(nodeLicense).digest('hex') !== '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace') throw new Error('Pinned Node license mismatch');
await writeFile(join(cliDir, 'NODE-LICENSE.txt'), nodeLicense);
if (platform === 'win32') {
  await writeFile(join(cliDir, 'organis.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0bootstrap.cjs" %*\r\nexit /b %errorlevel%\r\n');
} else {
  await writeFile(join(cliDir, 'organis'), '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/node" "$base/bootstrap.cjs" "$@"\n');
  await chmod(join(cliDir, 'organis'), 0o755);
}
const cliResult = JSON.parse(run(join(cliDir, nodeName), [join(cliDir, 'bootstrap.cjs'), 'status', '--json']));
if (cliResult.version !== meta.version || cliResult.platform !== platform || cliResult.arch !== arch) throw new Error('Packaged CLI smoke failed');
cliExecution = await smokeCLI(join(cliDir, nodeName), join(cliDir, 'bootstrap.cjs'), { earlyInterrupt: true });
}
if (includeDesktop) {
// The optional profile references credentials already in this host's keychain.
// Never export keys or copy credentials into a checkout or build artifact.
if (includeDesktop && !verificationOnly && platform === 'darwin' && process.env.ORGANIS_NOTARY_PROFILE) {
  process.env.APPLE_KEYCHAIN_PROFILE = process.env.ORGANIS_NOTARY_PROFILE;
}
if (verificationOnly) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await buildDesktop({
  projectDir: root,
  publish: 'never',
  dir: verificationOnly,
  config: {
    ...builderConfig,
    electronVersion: meta.devDependencies.electron,
    directories: { ...builderConfig.directories, output: desktopOutput },
    forceCodeSigning: !verificationOnly && platform === 'darwin',
    mac: {
      ...builderConfig.mac,
      sign: verificationOnly ? undefined : options => signMac(options),
      identity: verificationOnly ? null : process.env.ORGANIS_MAC_SIGNING_IDENTITY?.replace(/^Developer ID Application:\s*/, ''),
      notarize: !verificationOnly && platform === 'darwin' && Boolean(process.env.ORGANIS_NOTARY_PROFILE)
    }
  }
});
const appBundle = join(desktopOutput, 'mac-arm64', 'Organis.app');
const executable = platform === 'win32' ? join(desktopOutput, 'win-unpacked', 'Organis.exe') :
  platform === 'darwin' ? join(appBundle, 'Contents/MacOS/Organis') : join(desktopOutput, 'linux-unpacked', 'organis');
if (!verificationOnly && platform === 'darwin') {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
  const details = spawnSync('codesign', ['--display', '--verbose=4', appBundle], { encoding: 'utf8' });
  if (details.status !== 0 || !/^Authority=Developer ID Application: /m.test(details.stderr) || !/^TeamIdentifier=\S+/m.test(details.stderr)) {
    throw new Error('macOS application is not signed with a Developer ID Application identity');
  }
  signed = true;
  if (process.env.ORGANIS_NOTARY_PROFILE) {
    run('xcrun', ['stapler', 'validate', appBundle]);
    notarized = true;
  }
}
const smokeEnv = {...process.env};
delete smokeEnv.ELECTRON_RUN_AS_NODE;
if (platform === 'linux') delete smokeEnv.WAYLAND_DISPLAY;
const smokeResult = run(platform === 'linux' ? 'xvfb-run' : executable,
  platform === 'linux' ? ['-a', executable, '--ozone-platform=x11', '--smoke-test'] : ['--smoke-test'],
  {env: smokeEnv, timeout: 60000});
if (!smokeResult.includes('ORGANIS_DESKTOP_SMOKE_OK')) throw new Error('Desktop renderer smoke marker missing');
if (!smokeResult.includes('ORGANIS_DESKTOP_EXECUTION_SMOKE_OK')) throw new Error('Desktop execution smoke marker missing');
if (!smokeResult.includes('ORGANIS_DESKTOP_CODEX_CHECK_SMOKE_OK')) throw new Error('Desktop Codex connection smoke marker missing');
const unavailableSmokeResult = run(platform === 'linux' ? 'xvfb-run' : executable,
  platform === 'linux' ? ['-a', executable, '--ozone-platform=x11', '--smoke-runtime-unavailable'] : ['--smoke-runtime-unavailable'],
  { env: smokeEnv, timeout: 30000 });
if (!unavailableSmokeResult.includes('ORGANIS_DESKTOP_UNAVAILABLE_SMOKE_OK')) throw new Error('Runtime failure recovery UI smoke marker missing');
}
if (verificationOnly) {
  const evidence = { schemaVersion: 1, kind: 'development-package-verification', sourceSha, sourceDirty,
    app, version: meta.version, target, node: process.versions.node, electron: meta.devDependencies.electron,
    cli: cliExecution ?? null, desktop: includeDesktop ? { rendererIsolation: true, fixtureCompletion: true, fixtureCancellation: true, runtimeUnavailableUI: true, codexConnectionDiagnostic: true } : null,
    releaseSigningVerified: false, installerVerified: false };
  await writeFile(join(output, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(0);
}
async function archive(directory, name) {
  const extension = '.tar.gz';
  const destination = join(output, name + extension);
  await tar({gzip: true, file: destination, cwd: dirname(directory)}, [basename(directory)]);
  const bytes = await readFile(destination);
  return {file: name + extension, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
}
const files = includeCLI ? [await archive(cliDir, cliName)] : [];
if (includeDesktop) {
const desktopName = `organis-desktop-${meta.version}-${target}`;
const feed = platform === 'win32' ? 'beta.yml' : platform === 'darwin' ? 'beta-mac.yml' : 'beta-linux.yml';
const requiredNames = platform === 'win32' ? [`${desktopName}.exe`, `${desktopName}.exe.blockmap`, feed] :
  platform === 'darwin' ? [`${desktopName}.zip`, `${desktopName}.zip.blockmap`, `${desktopName}.dmg`, feed] :
    [`${desktopName}.AppImage`, feed];
const optionalNames = platform === 'darwin' ? [`${desktopName}.dmg.blockmap`] : [];
const builtNames = await readdir(desktopOutput);
for (const name of requiredNames) {
  if (!builtNames.includes(name)) throw new Error(`Missing desktop release asset: ${name}`);
}
for (const name of [...requiredNames, ...optionalNames.filter(name => builtNames.includes(name))]) {
  await cp(join(desktopOutput, name), join(output, name));
  const bytes = await readFile(join(output, name));
  files.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
}
const manifest = {
  schemaVersion: app === 'all' ? 1 : 2, ...(app === 'all' ? {} : { app }), product: 'Organis', version: meta.version,
  source: {repository: 'organis-labs/organis', sha: sourceSha, dirty: sourceDirty},
  target, platform, arch, node: process.versions.node, electron: meta.devDependencies.electron,
  lockfileSha256: createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),
  builtAt: new Date().toISOString(), signed, notarized,
  smoke: {cli: includeCLI, desktopRenderer: includeDesktop, ...(includeCLI ? { cliExecution } : {}), desktopExecution: includeDesktop},
  workflow: process.env.GITHUB_RUN_ID ? {repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT} : null,
  files
};
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(output, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.file}`).join('\n') + '\n');
console.log(JSON.stringify(manifest, null, 2));
