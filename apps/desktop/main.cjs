const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createUpdateController } = require('./updates.cjs');

const smoke = process.argv.includes('--smoke-test');
let smokeTimer;
let mainWindow;
let updates;
const documentURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
function trustedSender(event) {
  return mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && event.senderFrame.url === documentURL;
}
function createWindow() {
  const window = new BrowserWindow({
    width: 1000, height: 720, minWidth: 640, minHeight: 480,
    title: `Organis ${app.getVersion()}`, show: !smoke,
    backgroundColor: '#faf4ea',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'preload.cjs') }
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { if (smoke) app.exit(1); });
  if (smoke) {
    smokeTimer = setTimeout(() => app.exit(1), 20000);
    window.webContents.once('did-fail-load', () => app.exit(1));
    window.webContents.once('did-finish-load', async () => {
      try {
        const state = await window.webContents.executeJavaScript('({title:document.querySelector("h1").textContent, requireType:typeof require, processType:typeof process})');
        if (state.title !== 'Organis' || state.requireType !== 'undefined' || state.processType !== 'undefined') throw new Error('Unexpected renderer content or Node exposure');
        clearTimeout(smokeTimer);
        console.log('ORGANIS_DESKTOP_SMOKE_OK');
        app.exit(0);
      } catch (error) { console.error(error.message); app.exit(1); }
    });
  }
  window.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(() => {
  // Smoke builds load the same updater and its packaged dependencies without
  // making a network request. Missing production dependencies must fail CI.
  const packagedUpdater = app.isPackaged ? require('electron-updater').autoUpdater : null;
  const disabledReason = smoke ? 'smoke-test' : !app.isPackaged ? 'development'
    : process.platform === 'linux' && !process.env.APPIMAGE ? 'appimage-required' : null;
  updates = createUpdateController({
    updater: disabledReason ? null : packagedUpdater,
    currentVersion: app.getVersion(), disabledReason,
    onState: state => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL() === documentURL) {
        mainWindow.webContents.send('updates:state', state);
      }
    }
  });
  for (const [channel, action] of Object.entries({ status: updates.snapshot, check: updates.check, install: updates.install })) {
    ipcMain.handle(`updates:${channel}`, event => {
      if (!trustedSender(event)) throw new Error('Update request denied');
      return action();
    });
  }
  createWindow();
  updates.start();
});
app.on('before-quit', () => updates?.dispose());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !smoke) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit(); });
