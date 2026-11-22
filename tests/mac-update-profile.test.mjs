import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import updateProfile from '../apps/desktop/mac-update-profile.cjs';

const { createMacUpdateProfile } = updateProfile;
const unix = { skip: process.platform === 'win32' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'organis-update-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const account = { homedir: root, uid: userInfo().uid };
  const executable = join(root, 'Organis.app', 'Organis');
  const custom = { HOME: join(root, 'runtime home'), CFFIXED_USER_HOME: join(root, 'native home') };
  const profile = join(root, 'custom profile');
  const sessionData = join(root, 'custom session');
  let time = 1;

  function launch({ version = '0.1.0-beta.8', binary = executable, explicit = false, env = {} } = {}) {
    const paths = {};
    const app = {
      commandLine: { hasSwitch: () => explicit },
      getVersion: () => version,
      getPath: name => name === 'userData' ? profile : sessionData,
      setPath: (name, value) => { paths[name] = value; }
    };
    const handoff = createMacUpdateProfile({ app, environment: env, account, executable: binary, now: () => time });
    return { ...handoff, paths, env };
  }

  return { root, profile, sessionData, custom, launch, setTime: value => { time = value; } };
}

test('an update restores only the next launch of the same executable and version', unix, t => {
  const f = fixture(t);
  const previous = f.launch({ version: '0.1.0-beta.7', env: { ...f.custom, EXTRA: 'discard' } });
  previous.prepare('0.1.0-beta.8');
  assert.throws(() => previous.prepare('0.1.0-beta.8'), { code: 'EEXIST' });

  for (const launch of [f.launch({ version: '0.1.0-beta.7' }), f.launch({ binary: join(f.root, 'copy') })]) {
    launch.restore();
    assert.deepEqual(launch.paths, {});
  }
  const updated = f.launch();
  updated.restore();
  assert.deepEqual(updated.paths, { userData: f.profile, sessionData: f.sessionData });
  assert.deepEqual(updated.env, f.custom);
  const second = f.launch();
  second.restore();
  assert.deepEqual(second.paths, {});
});

test('an explicit new launch setting takes precedence over a saved profile', unix, t => {
  const f = fixture(t);
  f.launch({ env: f.custom }).prepare('0.1.0-beta.8');
  const explicit = f.launch({ explicit: true });
  explicit.restore();
  assert.deepEqual(explicit.paths, {});
  const clean = f.launch();
  clean.restore();
  assert.deepEqual(clean.paths, {});
});

test('normal installs, installer cleanup and expired handoffs cannot override the profile', unix, t => {
  const f = fixture(t);
  assert.equal(f.launch({ env: { HOME: f.root } }).prepare('0.1.0-beta.8'), undefined);
  f.launch({ explicit: true }).prepare('0.1.0-beta.8')();
  const canceled = f.launch();
  canceled.restore();
  assert.deepEqual(canceled.paths, {});

  f.launch({ explicit: true }).prepare('0.1.0-beta.8');
  f.setTime(16 * 60 * 1000);
  const expired = f.launch();
  expired.restore();
  assert.deepEqual(expired.paths, {});
});
