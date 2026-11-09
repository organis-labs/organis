const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createUpdateController } = require('./updates.cjs');
const { createExecutionController } = require('./execution.cjs');
const { mkdtempSync, mkdirSync, rmdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');

const unavailableSmoke = process.argv.includes('--smoke-runtime-unavailable');
const smoke = process.argv.includes('--smoke-test') || unavailableSmoke;
let smokeTimer;
let mainWindow;
let updates;
let execution;
let quitting = false;
const smokeRoot = smoke ? mkdtempSync(path.join(tmpdir(), 'organis-desktop-smoke-')) : null;
if (smoke) {
  app.setPath('userData', path.join(smokeRoot, 'profile'));
  mkdirSync(path.join(smokeRoot, 'workspace'));
  if (unavailableSmoke) writeFileSync(path.join(smokeRoot, 'state'), 'Deliberately invalid state directory for smoke test');
}
async function finishSmoke(code) {
  clearTimeout(smokeTimer);
  try { await execution?.close(); }
  catch (error) { console.error(error.message); code = 1; }
  updates?.dispose();
  // Chromium profile handles can remain open until app exit on Windows.
  if (smokeRoot) { try { rmSync(path.join(smokeRoot, 'state'), { recursive: true, force: true }); } catch {} }
  app.exit(code);
}
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
    smokeTimer = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 45000);
    window.webContents.once('did-fail-load', () => app.exit(1));
    window.webContents.once('did-finish-load', async () => {
      try {
        const state = await window.webContents.executeJavaScript('({title:document.querySelector("h1").textContent, requireType:typeof require, processType:typeof process})');
        if (state.title !== 'Organis' || state.requireType !== 'undefined' || state.processType !== 'undefined') throw new Error('Unexpected renderer content or Node exposure');
        if (unavailableSmoke) {
          await window.webContents.executeJavaScript(`(async () => {
            const deadline = Date.now() + 10000;
            while (!document.querySelector('#execution-status').textContent.includes('unavailable') || !document.querySelector('#app-version').textContent) {
              if (Date.now() > deadline) throw new Error('Runtime failure was not shown');
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            const state = await window.organisUpdates.status();
            if (!state.currentVersion || !document.querySelector('#app-version').textContent) throw new Error('Updater unavailable after runtime failure');
            let changes = 0;
            const observer = new MutationObserver(() => changes++);
            observer.observe(document.querySelector('#execution-status'), { childList: true, characterData: true, subtree: true });
            await new Promise(resolve => setTimeout(resolve, 1200));
            observer.disconnect();
            if (changes) throw new Error('Unchanged runtime error was announced again');
          })()`);
          console.log('ORGANIS_DESKTOP_UNAVAILABLE_SMOKE_OK');
          await finishSmoke(0);
          return;
        }
        await window.webContents.executeJavaScript(`(async () => {
          document.querySelector('#choose-workspace').click();
          const deadline = Date.now() + 10000;
          while (document.querySelector('#start-fixture').disabled) {
            if (Date.now() > deadline) throw new Error('Workspace selection timed out');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        })()`);
        // Remove only the empty synthetic workspace to exercise a real IPC failure.
        rmdirSync(path.join(smokeRoot, 'workspace'));
        await window.webContents.executeJavaScript(`(async () => {
          document.querySelector('#start-fixture').click();
          const status = document.querySelector('#execution-status');
          const deadline = Date.now() + 10000;
          while (document.querySelector('#start-fixture').disabled || !/workspace|ENOENT/i.test(status.textContent)) {
            if (Date.now() > deadline) throw new Error('Missing workspace failure was not shown');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          const message = status.textContent;
          let changes = 0;
          const observer = new MutationObserver(() => changes++);
          observer.observe(status, { childList: true, characterData: true, subtree: true });
          await new Promise(resolve => setTimeout(resolve, 1200));
          observer.disconnect();
          if (status.textContent !== message || changes) throw new Error('Polling replaced or repeated the action error');
          if ((await window.organisExecution.list()).length) throw new Error('Failed start created a run');
        })()`);
        mkdirSync(path.join(smokeRoot, 'workspace'));
        await window.webContents.executeJavaScript(`(async () => {
          const wait = async predicate => {
            const deadline = Date.now() + 15000;
            while (!predicate()) {
              if (Date.now() > deadline) throw new Error('Renderer execution check timed out: ' + document.querySelector('#execution-status').textContent);
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          };
          document.querySelector('#choose-workspace').click();
          await wait(() => !document.querySelector('#start-fixture').disabled);
          document.querySelector('#start-fixture').click();
          await wait(() => document.querySelector('#runs li[data-state="completed"]'));
          const mode = document.querySelector('#fixture-mode');
          mode.value = 'wait'; mode.dispatchEvent(new Event('change'));
          document.querySelector('#start-fixture').click();
          await wait(() => document.querySelector('#runs li[data-state="running"] .cancel-run'));
          document.querySelector('#runs li[data-state="running"] .cancel-run').click();
          await wait(() => document.querySelector('#runs li[data-state="cancelled"]'));
          const runs = await window.organisExecution.list();
          const completed = runs.find(run => run.state === 'completed');
          const events = await window.organisExecution.events(completed.id);
          if (!events.length || !runs.some(run => run.state === 'cancelled')) throw new Error('Missing persisted execution evidence');
          return true;
        })()`);
        console.log('ORGANIS_DESKTOP_EXECUTION_SMOKE_OK');
        console.log('ORGANIS_DESKTOP_SMOKE_OK');
        await finishSmoke(0);
      } catch (error) { console.error(error.message); await finishSmoke(1); }
    });
  }
  window.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(async () => {
  execution = await createExecutionController({
    app, trustedSender, getWindow: () => mainWindow,
    stateDir: smoke ? path.join(smokeRoot, 'state') : undefined,
    smokeWorkspace: smoke ? path.join(smokeRoot, 'workspace') : undefined
  });
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
}).catch(error => { console.error(`Startup failed: ${error.message}`); app.exit(1); });
app.on('before-quit', event => {
  updates?.dispose();
  if (!quitting && execution) {
    event.preventDefault();
    quitting = true;
    execution.close().then(() => app.quit()).catch(error => {
      console.error(`Execution shutdown failed: ${error.message}`);
      app.exit(1);
    });
  }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !smoke) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit(); });
