const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const smoke = process.argv.includes('--smoke-test');
let smokeTimer;
function createWindow() {
  const window = new BrowserWindow({
    width: 1000, height: 720, minWidth: 640, minHeight: 480,
    title: `Organis ${app.getVersion()}`, show: !smoke,
    backgroundColor: '#faf4ea',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
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
app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !smoke) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit(); });
