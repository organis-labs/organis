import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { assetURL, compareVersions, nativeTarget, selectRelease, updateCLI, validateEntry, validateManifest, verifyArchive } from '../apps/cli/src/update.mjs';
const { selectBundle } = createRequire(import.meta.url)('../apps/cli/bootstrap.cjs');
const version = '0.1.0-beta.2';
const target = nativeTarget();
const filename = `organis-cli-${version}-${target}.tar.gz`;
const bytes = Buffer.from('synthetic archive');
const metadata = { file: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const manifest = { schemaVersion: 2, app: 'cli', product: 'Organis', version, target,
  source: { repository: 'organis-labs/organis', sha: 'a'.repeat(40), dirty: false }, smoke: { cli: true }, files: [metadata] };
function release(ver = version) {
  return { tag_name: `cli-v${ver}`, draft: false, prerelease: true,
    assets: [`cli-manifest-${target}.json`, `organis-cli-${ver}-${target}.tar.gz`].map(name => ({ name,
      browser_download_url: `https://github.com/organis-labs/organis/releases/download/cli-v${ver}/${name}` })) };
}

test('beta selection rejects drafts, stable releases, equal versions and downgrades', () => {
  assert.equal(compareVersions('0.1.0-beta.10', '0.1.0-beta.2'), 1);
  assert.equal(selectRelease([release('0.1.0-beta.1'), release()], version), null);
  const candidates = [release(), { ...release('0.1.0-beta.4'), draft: true },
    { ...release('0.1.0-beta.5'), prerelease: false }, release('0.1.0-beta.3')];
  assert.equal(selectRelease(candidates, '0.1.0-beta.1').tag_name, 'cli-v0.1.0-beta.3');
  assert.throws(() => compareVersions('../version', version), /Unsupported/);
});

test('asset URLs are pinned to the release and public repository', () => {
  assert.match(assetURL(release(), filename), /^https:\/\/github.com\/organis-labs\/organis\//);
  const wrong = release();
  wrong.assets[1].browser_download_url = 'https://example.com/archive.tar.gz';
  assert.throws(() => assetURL(wrong, filename), /Invalid release asset/);
  wrong.assets.push(wrong.assets[0]);
  assert.throws(() => assetURL(wrong, `cli-manifest-${target}.json`), /Invalid release asset/);
});

test('manifest requires the selected version, native target, clean source and digest', () => {
  assert.deepEqual(validateManifest(manifest, version, target), metadata);
  for (const invalid of [{ ...manifest, version: '0.1.0-beta.3' },
    { ...manifest, schemaVersion: 1 }, { ...manifest, app: 'desktop' },
    { ...manifest, target: 'other-target' }, { ...manifest, source: { ...manifest.source, dirty: true } },
    { ...manifest, files: [{ ...metadata, sha256: '../invalid' }] }]) {
    assert.throws(() => validateManifest(invalid, version, target));
  }
  verifyArchive(bytes, metadata);
  assert.throws(() => verifyArchive(Buffer.from('tampered'), metadata), /checksum mismatch/);
});

test('archive validation rejects traversal, links, absolute and Windows-special paths', () => {
  const prefix = `organis-cli-${version}-${target}`;
  assert.equal(validateEntry({ path: `${prefix}/apps/cli/src/main.mjs`, type: 'File', size: 12 }, prefix), true);
  for (const path of [`${prefix}/../escape`, '/absolute', `${prefix}\\escape`, `${prefix}/C:stream`,
    'other/file', `${prefix}/CON`, `${prefix}/file.`, `${prefix}//double`]) {
    assert.throws(() => validateEntry({ path, type: 'File', size: 0 }, prefix), /Unsafe/);
  }
  for (const type of ['SymbolicLink', 'Link', 'FIFO', 'CharacterDevice']) {
    assert.throws(() => validateEntry({ path: `${prefix}/file`, type, size: 0 }, prefix), /Unsafe/);
  }
});

test('launcher rejects escaping pointers and selects a contained version', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'organis-launcher-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(selectBundle(root), root);
  await mkdir(join(root, '.organis', 'versions', version), { recursive: true });
  const pointer = join(root, '.organis', 'current.json');
  await writeFile(pointer, JSON.stringify({ version: '../escape' }));
  assert.throws(() => selectBundle(root), /Invalid CLI version pointer/);
  await writeFile(pointer, JSON.stringify({ version }));
  assert.equal(selectBundle(root), join(root, '.organis', 'versions', version));
});

test('check-only fetches metadata without downloading or modifying an installation', async () => {
  const requests = [];
  const result = await updateCLI({ currentVersion: '0.1.0-beta.1', checkOnly: true, target, log: () => {},
    fetchImpl: async url => {
      requests.push(url);
      return new Response(JSON.stringify(url.includes('/releases?') ? [release()] : manifest));
    } });
  assert.equal(result.availableVersion, version);
  assert.equal(requests.length, 2);
});

test('checksum failure leaves the active installation unchanged and releases its lock', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'organis-update-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'bootstrap.cjs'), '// fixture');
  const fetchImpl = async url => new Response(url.includes('/releases?') ? JSON.stringify([release()])
    : url.endsWith('.json') ? JSON.stringify(manifest) : 'wrong archive');
  await assert.rejects(updateCLI({ currentVersion: '0.1.0-beta.1', installRoot: root, target, fetchImpl, log: () => {} }), /checksum mismatch/);
  assert.equal(selectBundle(root), root);
  assert.deepEqual(await readdir(join(root, '.organis')), ['versions']);
});

test('source checkout update fails before making a network request', async () => {
  await assert.rejects(updateCLI({ currentVersion: '0.1.0-beta.1', installRoot: '',
    fetchImpl: () => { throw new Error('unexpected network'); } }), /bundled CLI launcher/);
});

test('an existing update lock is preserved and includes explicit recovery instructions', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'organis-lock-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'bootstrap.cjs'), '// fixture');
  const lock = join(root, '.organis', 'update.lock');
  await mkdir(lock, { recursive: true });
  const fetchImpl = async url => new Response(JSON.stringify(url.includes('/releases?') ? [release()] : manifest));
  await assert.rejects(updateCLI({ currentVersion: '0.1.0-beta.1', installRoot: root, target, fetchImpl, log: () => {} }), error => {
    assert.ok(error.message.includes(lock));
    assert.match(error.message, /Verify that no Organis updater is running/);
    assert.match(error.message, /manually removing this empty directory/);
    return true;
  });
  assert.deepEqual(await readdir(lock), []);
});

test('an unselected pre-existing version is never deleted and has manual recovery guidance', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'organis-orphan-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'bootstrap.cjs'), '// fixture');
  const orphan = join(root, '.organis', 'versions', version);
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, 'keep.txt'), 'unknown existing files');
  const fetchImpl = async url => new Response(JSON.stringify(url.includes('/releases?') ? [release()] : manifest));
  await assert.rejects(updateCLI({ currentVersion: '0.1.0-beta.1', installRoot: root, target, fetchImpl, log: () => {} }), error => {
    assert.ok(error.message.includes(orphan));
    assert.match(error.message, /confirming this directory is not selected/);
    return true;
  });
  assert.equal(await readFile(join(orphan, 'keep.txt'), 'utf8'), 'unknown existing files');
  assert.deepEqual(await readdir(join(root, '.organis')), ['versions']);
});

test('verified archive installs a new version atomically while preserving the initial runtime', async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'organis-upgrade-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const root = join(work, 'installed');
  const prefix = `organis-cli-${version}-${target}`;
  const bundle = join(work, prefix);
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  await mkdir(root);
  await writeFile(join(root, 'bootstrap.cjs'), '// initial bootstrap fixture');
  await writeFile(join(root, nodeName), 'initial runtime remains unchanged');
  await mkdir(join(bundle, 'apps', 'cli', 'src'), { recursive: true });
  await copyFile(process.execPath, join(bundle, nodeName));
  await chmod(join(bundle, nodeName), 0o755);
  await writeFile(join(bundle, 'apps', 'cli', 'src', 'main.mjs'), `console.log('${version}');\n`);
  const archivePath = join(work, 'fixture.tar.gz');
  await createTar({ file: archivePath, cwd: work, gzip: { level: 1 } }, [prefix]);
  const archiveBytes = await readFile(archivePath);
  const archiveManifest = { ...manifest, files: [{ file: filename, bytes: archiveBytes.length,
    sha256: createHash('sha256').update(archiveBytes).digest('hex') }] };
  const fetchImpl = async url => new Response(url.includes('/releases?') ? JSON.stringify([release()])
    : url.endsWith('.json') ? JSON.stringify(archiveManifest) : archiveBytes);
  const previousVersion = '0.1.0-beta.1';
  const previousDirectory = join(root, '.organis', 'versions', previousVersion);
  await mkdir(previousDirectory, { recursive: true });
  await writeFile(join(previousDirectory, 'preserve.txt'), 'previous version');
  const pointer = join(root, '.organis', 'current.json');
  await writeFile(pointer, JSON.stringify({ version: previousVersion }));
  await assert.rejects(updateCLI({ currentVersion: previousVersion, installRoot: root, target, fetchImpl, log: () => {},
    replacePointer: async () => { throw new Error('synthetic pointer replacement failure'); } }), /synthetic pointer replacement failure/);
  assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), { version: previousVersion });
  assert.equal(selectBundle(root), previousDirectory);
  assert.equal(await readFile(join(previousDirectory, 'preserve.txt'), 'utf8'), 'previous version');
  assert.deepEqual(await readdir(join(root, '.organis', 'versions')), [previousVersion]);
  assert.equal(await readFile(join(root, nodeName), 'utf8'), 'initial runtime remains unchanged');
  const result = await updateCLI({ currentVersion: '0.1.0-beta.1', installRoot: root, target, fetchImpl, log: () => {} });
  assert.deepEqual(result, { updated: true, version });
  assert.equal(selectBundle(root), join(root, '.organis', 'versions', version));
  assert.equal(await readFile(join(root, nodeName), 'utf8'), 'initial runtime remains unchanged');
  assert.deepEqual(JSON.parse(await readFile(join(root, '.organis', 'current.json'), 'utf8')), { version });
  assert.deepEqual((await readdir(join(root, '.organis'))).sort(), ['current.json', 'versions']);
  // A stale process cannot replace a version that another process already selected.
  const again = await updateCLI({ currentVersion: '0.1.0-beta.1', installRoot: root, target, fetchImpl, log: () => {} });
  assert.deepEqual(again, { updated: false });
});
