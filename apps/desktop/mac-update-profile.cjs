const { createHash, randomUUID } = require('node:crypto');
const { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { userInfo } = require('node:os');
const { isAbsolute, join } = require('node:path');

const MAX_AGE_MS = 15 * 60 * 1000;
const PROFILE_SWITCH = 'user-data-dir';

function createMacUpdateProfile({ app, environment = process.env, executable = realpathSync(process.execPath),
  account = userInfo(), now = Date.now }) {
  // Use the macOS account home because LaunchServices can drop a custom HOME.
  const directory = join(account.homedir, 'Library', 'Caches', 'org.organislabs.organis-update-profile');
  const pendingPath = version => join(directory, createHash('sha256')
    .update(JSON.stringify([executable, version])).digest('hex'));
  const customHome = name => isAbsolute(environment[name] ?? '') && environment[name] !== account.homedir;
  const hasProfileOverride = () => app.commandLine.hasSwitch(PROFILE_SWITCH)
    || customHome('HOME') || customHome('CFFIXED_USER_HOME');

  function privateEntry(stat) {
    return stat.uid === account.uid && (stat.mode & 0o077) === 0;
  }

  function privateDirectory() {
    const stat = lstatSync(directory);
    return stat.isDirectory() && privateEntry(stat);
  }

  function discard(file) {
    try { rmSync(file, { force: true }); } catch { /* A stale record still expires. */ }
  }

  function prepare(version) {
    if (!hasProfileOverride()) return;
    const profile = app.getPath('userData');
    const sessionData = app.getPath('sessionData');
    if (!isAbsolute(profile) || !isAbsolute(sessionData)) throw new Error('Invalid update profile path');
    const record = { profile, sessionData, savedAt: now() };
    for (const name of ['HOME', 'CFFIXED_USER_HOME']) {
      if (customHome(name)) record[name] = environment[name];
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!privateDirectory()) throw new Error('Update profile storage is not private');
    const pending = pendingPath(version);
    const temporary = join(directory, randomUUID());
    try {
      try {
        if (Date.now() - lstatSync(pending).mtimeMs > MAX_AGE_MS) discard(pending);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      linkSync(temporary, pending);
    } finally { discard(temporary); }
    return () => discard(pending);
  }

  function restore() {
    const claimed = join(directory, randomUUID());
    let record;
    try {
      if (!privateDirectory()) return;
      // Claim before reading so simultaneous launches cannot reuse the record.
      renameSync(pendingPath(app.getVersion()), claimed);
      const stat = lstatSync(claimed);
      if (!stat.isFile() || !privateEntry(stat) || stat.size > 16384) return;
      record = JSON.parse(readFileSync(claimed, 'utf8'));
    } catch { return; }
    finally { discard(claimed); }

    if (!Number.isFinite(record?.savedAt)) return;
    const age = now() - record.savedAt;
    if (hasProfileOverride() || age < 0 || age > MAX_AGE_MS
      || typeof record.profile !== 'string' || !isAbsolute(record.profile)
      || typeof record.sessionData !== 'string' || !isAbsolute(record.sessionData)) return;
    for (const name of ['HOME', 'CFFIXED_USER_HOME']) {
      if (typeof record[name] === 'string' && isAbsolute(record[name])) {
        environment[name] = record[name];
      }
    }
    app.setPath('userData', record.profile);
    app.setPath('sessionData', record.sessionData);
  }

  return { prepare, restore };
}

module.exports = { createMacUpdateProfile };
