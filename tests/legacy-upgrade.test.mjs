import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider.js');
const { SemVer } = require('semver');

// Frozen beta.3 selector/manifest rules from 59c152a. These must not change
// alongside the modern updater: they characterize already-installed clients.
const REPOSITORY = 'organis-labs/organis';
const API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_EXPANDED = 768 * 1024 * 1024;
const betaPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;

function validVersion(value) {
  return typeof value === 'string' && value.length <= 64 && betaPattern.test(value);
}
function compareVersions(left, right) {
  if (!validVersion(left) || !validVersion(right)) throw new Error('Unsupported beta version');
  const a = left.match(betaPattern).slice(1).map(BigInt);
  const b = right.match(betaPattern).slice(1).map(BigInt);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function nativeTarget(platform = process.platform, arch = process.arch) {
  const target = `${{ win32: 'windows', darwin: 'macos', linux: 'linux' }[platform]}-${arch}`;
  if (!['windows-x64', 'macos-arm64', 'linux-x64'].includes(target)) throw new Error('Unsupported update platform');
  return target;
}
function selectRelease(releases, currentVersion) {
  if (!Array.isArray(releases)) throw new Error('Invalid release response');
  return releases.filter(release => !release.draft && release.prerelease === true
    && typeof release.tag_name === 'string' && release.tag_name.startsWith('v')
    && validVersion(release.tag_name.slice(1))
    && compareVersions(release.tag_name.slice(1), currentVersion) > 0)
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0] ?? null;
}
function assetURL(release, name) {
  const candidates = release.assets?.filter(asset => asset.name === name) ?? [];
  const expected = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
  if (candidates.length !== 1 || candidates[0].browser_download_url !== expected) throw new Error(`Invalid release asset: ${name}`);
  return expected;
}
function validateManifest(manifest, version, target) {
  const file = `organis-cli-${version}-${target}.tar.gz`;
  if (manifest.schemaVersion !== 1 || manifest.product !== 'Organis' || manifest.version !== version
    || manifest.target !== target || manifest.source?.repository !== REPOSITORY
    || manifest.source.dirty !== false || !/^[a-f0-9]{40}$/.test(manifest.source.sha)
    || manifest.smoke?.cli !== true || !Array.isArray(manifest.files)) throw new Error('Release manifest does not match this update');
  const matches = manifest.files.filter(asset => asset.file === file);
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].sha256)
    || !Number.isSafeInteger(matches[0].bytes) || matches[0].bytes <= 0 || matches[0].bytes > MAX_ARCHIVE) throw new Error('Invalid CLI archive metadata');
  return matches[0];
}

const bridgeVersion = '0.1.0-beta.4';
const tags = ['desktop-v0.1.0-beta.8', 'cli-v0.1.0-beta.9', `v${bridgeVersion}`];
test('legacy CLI finds the complete bridge among independent app releases', () => {
  const records = tags.map(tag_name => ({ tag_name, draft: false, prerelease: true }));
  assert.equal(selectRelease(records, '0.1.0-beta.3').tag_name, `v${bridgeVersion}`);
  const file = `organis-cli-${bridgeVersion}-windows-x64.tar.gz`;
  const manifest = { schemaVersion: 1, product: 'Organis', version: bridgeVersion, target: 'windows-x64',
    source: { repository: REPOSITORY, sha: 'a'.repeat(40), dirty: false }, smoke: { cli: true },
    files: [{ file, bytes: 1, sha256: 'b'.repeat(64) }] };
  assert.equal(validateManifest(manifest, bridgeVersion, 'windows-x64').file, file);
  assert.throws(() => validateManifest({ ...manifest, files: [] }, bridgeVersion, 'windows-x64'), /archive metadata/);
  assert.equal(selectRelease(records.slice(0, 2), '0.1.0-beta.3'), null); // bridge aged out of history
});
test('a later legacy tag without CLI assets strands old clients instead of falling back', () => {
  const candidates = [`v${bridgeVersion}`, 'v0.1.0-beta.5'].map(tag_name => ({
    tag_name, draft: false, prerelease: true, assets: []
  }));
  const selected = selectRelease(candidates, '0.1.0-beta.3');
  assert.equal(selected.tag_name, 'v0.1.0-beta.5');
  assert.throws(() => assetURL(selected, 'manifest-windows-x64.json'), /Invalid release asset/);
});
function providerFor(feedTags) {
  const provider = new GitHubProvider({ owner: 'organis-labs', repo: 'organis' },
    { allowPrerelease: true, channel: 'beta', currentVersion: new SemVer('0.1.0-beta.3'), fullChangelog: false },
    { platform: 'win32', executor: { request: async options => {
      assert.equal(options.path, `/organis-labs/organis/releases/download/v${bridgeVersion}/beta.yml`);
      return `version: ${bridgeVersion}\nfiles:\n  - url: fixture.exe\n    sha512: fixture\npath: fixture.exe\nsha512: fixture\n`;
    } } });
  provider.httpRequest = async () => `<feed>${feedTags.map(tag => `<entry><link href="https://github.com/organis-labs/organis/releases/tag/${tag}"/><title>Fixture</title><content>Fixture</content></entry>`).join('')}</feed>`;
  return provider;
}
test('installed desktop GitHub provider skips app tags and selects bridge feed', async () => {
  const result = await providerFor(tags).getLatestVersion();
  assert.equal(result.version, bridgeVersion);
  assert.equal(result.tag, `v${bridgeVersion}`);
});
test('legacy desktop cannot auto-update after bridge leaves the bounded Atom feed', async () => {
  await assert.rejects(providerFor(tags.slice(0, 2)).getLatestVersion(), /No published versions/);
});
