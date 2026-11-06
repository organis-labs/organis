const status = document.querySelector('#update-status');
const check = document.querySelector('#check-update');
const install = document.querySelector('#install-update');

function render(state) {
  const messages = {
    idle: 'Updates are checked automatically.',
    checking: 'Checking for updates…',
    downloading: `Downloading ${state.availableVersion ?? 'update'}… ${state.percent ?? 0}%`,
    current: 'You have the latest beta version.',
    ready: `Version ${state.availableVersion ?? ''} is ready. Restart when you are ready to install it.`,
    installing: 'Restarting to install the update…',
    error: 'The update could not be completed. Please try again.',
    disabled: state.disabledReason === 'appimage-required'
      ? 'Automatic updates require launching the AppImage. Download the latest release from GitHub.'
      : 'Automatic updates are available in installed release builds.'
  };
  status.textContent = messages[state.phase] ?? messages.error;
  document.querySelector('#app-version').textContent = `Version ${state.currentVersion} · Beta channel`;
  check.disabled = ['disabled', 'checking', 'downloading', 'ready', 'installing'].includes(state.phase);
  install.hidden = state.phase !== 'ready';
}

window.organisUpdates.subscribe(render);
window.organisUpdates.status().then(render).catch(() => {
  status.textContent = 'Update status is unavailable.';
  check.disabled = true;
});
check.addEventListener('click', () => {
  check.disabled = true;
  window.organisUpdates.check().then(render).catch(() => {
    status.textContent = 'Unable to check for updates. Please try again.';
    check.disabled = false;
  });
});
install.addEventListener('click', () => {
  install.disabled = true;
  window.organisUpdates.install().then(accepted => {
    if (!accepted) install.disabled = false;
  }).catch(() => { install.disabled = false; });
});
