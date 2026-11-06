const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Keep updater policy independent of Electron so failures and install guards can
// be tested without accessing the network or modifying an installed application.
function createUpdateController({ updater, currentVersion, disabledReason = null,
  onState = () => {}, schedule = setInterval, cancel = clearInterval }) {
  let state = { phase: disabledReason ? 'disabled' : 'idle', currentVersion,
    availableVersion: null, percent: null, disabledReason };
  let timer;
  let started = false;
  let disposed = false;
  const listeners = [];
  const snapshot = () => ({ ...state });
  function update(values) {
    if (disposed) return;
    state = { ...state, ...values };
    onState(snapshot());
  }
  function failed() {
    if (state.phase !== 'installing') update({ phase: 'error', percent: null });
  }
  function listen(event, handler) {
    updater.on(event, handler);
    listeners.push([event, handler]);
  }
  if (!disabledReason) {
    if (!updater) throw new Error('An updater is required');
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = true;
    updater.channel = 'beta';
    // Setting channel enables downgrades in electron-updater; reset afterwards.
    updater.allowDowngrade = false;
    listen('checking-for-update', () => update({ phase: 'checking', percent: null }));
    listen('update-available', info => update({ phase: 'downloading', availableVersion: info.version, percent: 0 }));
    listen('update-not-available', () => update({ phase: 'current', availableVersion: null, percent: null }));
    listen('download-progress', info => {
      if (state.phase === 'downloading' && Number.isFinite(info.percent)) {
        update({ percent: Math.max(0, Math.min(100, Math.round(info.percent))) });
      }
    });
    listen('update-downloaded', info => update({ phase: 'ready', availableVersion: info.version, percent: 100 }));
    listen('error', failed);
  }
  async function check() {
    if (disposed || disabledReason || ['checking', 'downloading', 'ready', 'installing'].includes(state.phase)) return snapshot();
    update({ phase: 'checking', percent: null, availableVersion: null });
    try {
      const result = await updater.checkForUpdates();
      // Download failures may arrive both as events and rejected promises.
      result?.downloadPromise?.catch(failed);
      if (!result && state.phase === 'checking') failed();
    } catch { failed(); }
    return snapshot();
  }
  function install() {
    if (disposed || disabledReason || state.phase !== 'ready') return false;
    update({ phase: 'installing' });
    try { updater.quitAndInstall(false, true); return true; }
    catch { update({ phase: 'error', percent: null }); return false; }
  }
  function start() {
    if (started || disposed || disabledReason) return;
    started = true;
    void check();
    timer = schedule(() => { void check(); }, CHECK_INTERVAL_MS);
    timer?.unref?.();
  }
  function dispose() {
    disposed = true;
    if (timer !== undefined) cancel(timer);
    for (const [event, handler] of listeners) updater.removeListener(event, handler);
  }
  return { snapshot, check, install, start, dispose };
}

module.exports = { createUpdateController, CHECK_INTERVAL_MS };
