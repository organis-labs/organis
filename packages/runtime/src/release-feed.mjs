export const RELEASE_REPOSITORY = 'organis-labs/organis';
const betaPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;
export function validVersion(value) {
  return typeof value === 'string' && value.length <= 64 && betaPattern.test(value);
}
export function compareVersions(left, right) {
  if (!validVersion(left) || !validVersion(right)) throw new Error('Unsupported beta version');
  const a = left.match(betaPattern).slice(1).map(BigInt);
  const b = right.match(betaPattern).slice(1).map(BigInt);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function releaseVersion(tag, app) {
  if (!['cli', 'desktop'].includes(app)) throw new Error('Unknown application');
  const prefix = `${app}-v`;
  if (typeof tag !== 'string' || !tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  return validVersion(version) ? version : null;
}
export function selectAppRelease(releases, app, currentVersion) {
  if (!['cli', 'desktop'].includes(app)) throw new Error('Unknown application');
  if (!Array.isArray(releases)) throw new Error('Invalid release response');
  if (!validVersion(currentVersion)) throw new Error('Unsupported beta version');
  const candidates = releases.filter(release => release && release.draft === false && release.prerelease === true
    && releaseVersion(release.tag_name, app) !== null
    && compareVersions(releaseVersion(release.tag_name, app), currentVersion) > 0);
  const tags = new Set();
  for (const release of candidates) {
    if (tags.has(release.tag_name)) throw new Error('Duplicate release tag');
    tags.add(release.tag_name);
  }
  return candidates.sort((a, b) => compareVersions(releaseVersion(b.tag_name, app), releaseVersion(a.tag_name, app)))[0] ?? null;
}

// A bounded, complete history is required: do not report "current" after a
// truncated page or after the history cap. Never follow a server-supplied URL.
export async function listAppReleases(fetchImpl = fetch, { maxPages = 100 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid page limit');
  const releases = [];
  const signal = AbortSignal.timeout(120_000);
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Organis' }, signal, redirect: 'error'
    });
    if (!response.ok || !response.body) throw new Error(`Release discovery failed (HTTP ${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      total += chunk.length;
      if (size > 4 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error('Release history exceeds size limit');
      chunks.push(chunk);
    }
    const items = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(items) || items.length > 100) throw new Error('Invalid release response');
    releases.push(...items);
    if (items.length < 100) return releases;
  }
  throw new Error('Release history exceeds page limit');
}

export async function desktopFeed(currentVersion, fetchImpl = fetch) {
  const release = selectAppRelease(await listAppReleases(fetchImpl), 'desktop', currentVersion);
  if (!release) return null;
  return { provider: 'generic',
    url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${release.tag_name}/`,
    channel: 'beta', useMultipleRangeRequest: false };
}
