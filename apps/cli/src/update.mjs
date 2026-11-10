import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { t as listTar, x as extractTar } from 'tar';

import { RELEASE_REPOSITORY as REPOSITORY, validVersion, compareVersions, releaseVersion, selectAppRelease, listAppReleases } from '../../../packages/runtime/src/release-feed.mjs';
export { validVersion, compareVersions };
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_EXPANDED = 768 * 1024 * 1024;
export function nativeTarget(platform = process.platform, arch = process.arch) {
  const target = `${{ win32: 'windows', darwin: 'macos', linux: 'linux' }[platform]}-${arch}`;
  if (!['windows-x64', 'macos-arm64', 'linux-x64'].includes(target)) throw new Error('Unsupported update platform');
  return target;
}
export function selectRelease(releases, currentVersion) {
  return selectAppRelease(releases, 'cli', currentVersion);
}
export function assetURL(release, name) {
  if (!releaseVersion(release?.tag_name, 'cli') || typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('Invalid release asset');
  }
  const candidates = release.assets?.filter(asset => asset.name === name) ?? [];
  const expected = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
  if (candidates.length !== 1 || candidates[0].browser_download_url !== expected) throw new Error(`Invalid release asset: ${name}`);
  return expected;
}
export function validateManifest(manifest, version, target) {
  const file = `organis-cli-${version}-${target}.tar.gz`;
  if (manifest.schemaVersion !== 2 || manifest.app !== 'cli' || manifest.product !== 'Organis' || manifest.version !== version
    || manifest.target !== target || manifest.source?.repository !== REPOSITORY
    || manifest.source.dirty !== false || !/^[a-f0-9]{40}$/.test(manifest.source.sha)
    || manifest.smoke?.cli !== true || !Array.isArray(manifest.files)) throw new Error('Release manifest does not match this update');
  const matches = manifest.files.filter(asset => asset.file === file);
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].sha256)
    || !Number.isSafeInteger(matches[0].bytes) || matches[0].bytes <= 0 || matches[0].bytes > MAX_ARCHIVE) throw new Error('Invalid CLI archive metadata');
  return matches[0];
}
export function verifyArchive(bytes, metadata) {
  if (bytes.length !== metadata.bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('CLI archive checksum mismatch');
}
export function validateEntry(entry, prefix) {
  const name = entry.path;
  if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(name) || name.includes('//')
    || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')
    || name.split('/').some(part => part.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || !(name === prefix || name === `${prefix}/` || name.startsWith(`${prefix}/`))
    || !['File', 'Directory'].includes(entry.type)
    || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Unsafe CLI archive entry');
  return true;
}

async function fetchBytes(url, maxBytes, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Organis-CLI' }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Update download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('Update response exceeds size limit');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Update response exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJSON(url, limit, fetchImpl) {
  return JSON.parse((await fetchBytes(url, limit, fetchImpl)).toString('utf8'));
}
function equalPath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
async function safeDirectory(path, create = false) {
  if (create) { try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(await realpath(path), resolve(path))) throw new Error('Update directory must not use symbolic links');
}
async function assertRegular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid installed CLI file');
}

export async function updateCLI({ currentVersion, checkOnly = false, installRoot = process.env.ORGANIS_INSTALL_ROOT,
  fetchImpl = fetch, log = console.log, target = nativeTarget(), replacePointer = rename }) {
  if (!validVersion(currentVersion)) throw new Error('CLI updates require a beta release build');
  if (!checkOnly && !installRoot) throw new Error('Self-update requires the bundled CLI launcher; source checkouts are not modified');
  const release = selectRelease(await listAppReleases(fetchImpl), currentVersion);
  if (!release) { log(`Organis ${currentVersion} is up to date on the beta channel.`); return { updated: false }; }
  const nextVersion = releaseVersion(release.tag_name, 'cli');
  const manifest = await readJSON(assetURL(release, `cli-manifest-${target}.json`), 128 * 1024, fetchImpl);
  const archive = validateManifest(manifest, nextVersion, target);
  const url = assetURL(release, archive.file);
  if (checkOnly) { log(`Organis ${nextVersion} is available. Run organis update to install it.`); return { updated: false, availableVersion: nextVersion }; }

  const root = resolve(installRoot);
  await safeDirectory(root);
  await assertRegular(join(root, 'bootstrap.cjs'));
  const state = join(root, '.organis');
  await safeDirectory(state, true);
  const versions = join(state, 'versions');
  await safeDirectory(versions, true);
  const lock = join(state, 'update.lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Update lock exists: ${lock}. Verify that no Organis updater is running before manually removing this empty directory, then retry. A previous update may have stopped unexpectedly.`);
    throw error;
  }
  let stage;
  let pointerTemp;
  let destination;
  let installedByThisAttempt = false;
  let pointerCommitted = false;
  async function cleanup(action, description) {
    try { await action(); }
    catch {
      try { log(`Warning: could not clean up ${description}. Inspect it before retrying.`); }
      catch { /* Cleanup reporting must not replace the original update error. */ }
    }
  }
  try {
    // A process launched before another completed update must not move backwards.
    try {
      const pointer = join(state, 'current.json');
      await assertRegular(pointer);
      const active = JSON.parse(await readFile(pointer, 'utf8'));
      if (!validVersion(active.version)) throw new Error('Invalid installed version pointer');
      if (compareVersions(nextVersion, active.version) <= 0) { log('This version is already installed. Run the CLI again.'); return { updated: false }; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    destination = join(versions, nextVersion);
    try { await lstat(destination); throw new Error(`Unselected update directory already exists: ${destination}. Inspect ${join(state, 'current.json')} and verify that no updater is running. Only after confirming this directory is not selected, move it aside or remove it manually, then retry. Existing files will not be overwritten.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    stage = await mkdtemp(join(state, 'stage-'));
    const bytes = await fetchBytes(url, MAX_ARCHIVE, fetchImpl);
    verifyArchive(bytes, archive);
    const tarPath = join(stage, 'download.tar.gz');
    await writeFile(tarPath, bytes, { flag: 'wx' });
    const prefix = `organis-cli-${nextVersion}-${target}`;
    const seen = new Set();
    let expanded = 0;
    let entryFailure;
    await listTar({ file: tarPath, strict: true, onReadEntry: entry => {
      try {
        validateEntry(entry, prefix);
        const normalized = entry.path.replace(/\/$/, '');
        const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        if (seen.has(key)) throw new Error('Duplicate CLI archive entry');
        seen.add(key);
        expanded += entry.size;
        if (expanded > MAX_EXPANDED || seen.size > 20_000) throw new Error('CLI archive exceeds extraction limits');
      } catch (error) { entryFailure ??= error; }
    } });
    if (entryFailure) throw entryFailure;
    await extractTar({ file: tarPath, cwd: stage, strict: true, preservePaths: false,
      filter: (_path, entry) => validateEntry(entry, prefix) });
    const bundle = join(stage, prefix);
    await safeDirectory(bundle);
    const executable = join(bundle, process.platform === 'win32' ? 'node.exe' : 'node');
    const entry = join(bundle, 'apps', 'cli', 'src', 'main.mjs');
    await assertRegular(executable);
    await assertRegular(entry);
    const smoke = spawnSync(executable, [entry, '--version'], { encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, ORGANIS_INSTALL_ROOT: root }, windowsHide: true });
    if (smoke.error || smoke.status !== 0 || smoke.stdout.trim() !== nextVersion) throw new Error('Downloaded CLI version check failed');
    await rename(bundle, destination);
    installedByThisAttempt = true;
    pointerTemp = join(state, `current-${randomUUID()}.tmp`);
    await writeFile(pointerTemp, JSON.stringify({ version: nextVersion }) + '\n', { flag: 'wx' });
    await replacePointer(pointerTemp, join(state, 'current.json'));
    pointerCommitted = true;
    pointerTemp = null;
    log(`Updated Organis to ${nextVersion}. The next CLI invocation uses this version.`);
    return { updated: true, version: nextVersion };
  } catch (error) {
    if (installedByThisAttempt && !pointerCommitted) {
      // This exact directory was created by this locked attempt. Never remove
      // pre-existing versions or an update selected by a committed pointer.
      await cleanup(() => rm(destination, { recursive: true, force: true }), destination);
    }
    throw error;
  } finally {
    if (pointerTemp) await cleanup(() => rm(pointerTemp, { force: true }), pointerTemp);
    if (stage) await cleanup(() => rm(stage, { recursive: true, force: true }), stage);
    await cleanup(() => rmdir(lock), lock);
  }
}
