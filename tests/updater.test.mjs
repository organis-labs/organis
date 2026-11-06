import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdateController, CHECK_INTERVAL_MS } = require('../apps/desktop/updates.cjs');

function fixture(overrides = {}) {
  const updater = new EventEmitter();
  let checks = 0;
  let installs = 0;
  let scheduled;
  let cancelled;
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit('update-not-available');
    return {};
  };
  updater.quitAndInstall = (silent, relaunch) => {
    assert.equal(silent, false);
    assert.equal(relaunch, true);
    installs++;
  };
  const controller = createUpdateController({ updater, currentVersion: '0.1.0-beta.1',
    schedule: (callback, delay) => { scheduled = { callback, delay }; return 42; },
    cancel: handle => { cancelled = handle; }, ...overrides });
  return { updater, controller, get checks() { return checks; },
    get installs() { return installs; }, get scheduled() { return scheduled; },
    get cancelled() { return cancelled; } };
}

test('development, smoke and non-AppImage execution never check or install', async () => {
  for (const disabledReason of ['development', 'smoke-test', 'appimage-required']) {
    const f = fixture({ disabledReason });
    f.controller.start();
    await f.controller.check();
    assert.equal(f.checks, 0);
    assert.equal(f.scheduled, undefined);
    assert.equal(f.controller.install(), false);
    assert.equal(f.controller.snapshot().phase, 'disabled');
  }
});

test('startup checks once, schedules four-hour checks and disposes listeners', async () => {
  const f = fixture();
  f.controller.start();
  f.controller.start();
  assert.equal(f.checks, 1);
  assert.equal(f.scheduled.delay, CHECK_INTERVAL_MS);
  assert.equal(CHECK_INTERVAL_MS, 14_400_000);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.autoDownload, true);
  assert.equal(f.updater.allowPrerelease, true);
  f.scheduled.callback();
  assert.equal(f.checks, 2);
  f.controller.dispose();
  assert.equal(f.cancelled, 42);
  assert.equal(f.updater.listenerCount('update-downloaded'), 0);
  await f.controller.check();
  assert.equal(f.checks, 2);
});

test('installation requires completed download and explicit request, never repeats', async () => {
  const f = fixture();
  assert.equal(f.controller.install(), false);
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '0.1.0-beta.2' });
    return {};
  };
  await f.controller.check();
  assert.equal(f.controller.snapshot().phase, 'downloading');
  assert.equal(f.controller.install(), false);
  f.updater.emit('download-progress', { percent: 1000 });
  assert.equal(f.controller.snapshot().percent, 100);
  f.updater.emit('update-downloaded', { version: '0.1.0-beta.2' });
  assert.equal(f.installs, 0);
  await f.controller.check();
  assert.equal(f.controller.snapshot().phase, 'ready');
  assert.equal(f.controller.install(), true);
  assert.equal(f.controller.install(), false);
  assert.equal(f.installs, 1);
});

test('concurrent checks are suppressed and errors allow retry without exposing details', async () => {
  const f = fixture();
  let rejectCheck;
  let calls = 0;
  f.updater.checkForUpdates = () => {
    calls++;
    return new Promise((_resolve, reject) => { rejectCheck = reject; });
  };
  const pending = f.controller.check();
  await f.controller.check();
  assert.equal(calls, 1);
  rejectCheck(new Error('private token and path'));
  await pending;
  assert.equal(f.controller.snapshot().phase, 'error');
  assert.ok(!JSON.stringify(f.controller.snapshot()).includes('private'));
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-not-available');
    return {};
  };
  await f.controller.check();
  assert.equal(f.controller.snapshot().phase, 'current');
});

test('rejected automatic download becomes a recoverable error', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '0.1.0-beta.2' });
    return { downloadPromise: Promise.reject(new Error('download unavailable')) };
  };
  await f.controller.check();
  await Promise.resolve();
  assert.equal(f.controller.snapshot().phase, 'error');
  assert.equal(f.controller.install(), false);
});
