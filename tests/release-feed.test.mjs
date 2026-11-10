import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopFeed, listAppReleases, selectAppRelease } from '../packages/runtime/src/release-feed.mjs';
const release = tag => ({ tag_name: tag, draft: false, prerelease: true });

test('component discovery ignores legacy tags, other apps, drafts and downgrades', () => {
  const records = ['v0.1.0-beta.99', 'cli-v0.1.0-beta.7', 'desktop-v0.1.0-beta.5',
    'desktop-v0.1.0-beta.4', 'desktop-v../escape', 'desktop-v0.1.0-beta.05'].map(release);
  records.push({ ...release('desktop-v0.1.0-beta.8'), draft: true });
  records.push({ ...release('desktop-v0.1.0-beta.9'), prerelease: false });
  assert.equal(selectAppRelease(records, 'desktop', '0.1.0-beta.4').tag_name, 'desktop-v0.1.0-beta.5');
  assert.equal(selectAppRelease(records, 'cli', '0.1.0-beta.7'), null);
  assert.throws(() => selectAppRelease([records[2], records[2]], 'desktop', '0.1.0-beta.4'), /Duplicate/);
});

test('history pagination finds updates beyond the first 100 entries and bounds exhaustion', async () => {
  const calls = [];
  const full = Array.from({ length: 100 }, (_, i) => release(`cli-v0.1.0-beta.${i + 100}`));
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify(url.endsWith('page=1') ? full : [release('desktop-v0.1.0-beta.5')]));
  };
  const feed = await desktopFeed('0.1.0-beta.4', fetcher);
  assert.equal(calls.length, 2);
  assert.deepEqual(feed, { provider: 'generic', channel: 'beta', useMultipleRangeRequest: false,
    url: 'https://github.com/organis-labs/organis/releases/download/desktop-v0.1.0-beta.5/' });
  await assert.rejects(listAppReleases(async () => new Response(JSON.stringify(full)), { maxPages: 2 }), /page limit/);
});

test('empty component feed means current, but HTTP, malformed and oversized responses fail', async () => {
  assert.equal(await desktopFeed('0.1.0-beta.4', async () => new Response('[]')), null);
  await assert.rejects(desktopFeed('0.1.0-beta.4', async () => new Response('', { status: 403 })), /HTTP 403/);
  await assert.rejects(listAppReleases(async () => new Response('{}')), /Invalid release/);
  await assert.rejects(listAppReleases(async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))), /size limit/);
});
