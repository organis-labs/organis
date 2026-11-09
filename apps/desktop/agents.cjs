const { dialog, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

exports.createAgentController = async ({ app, trustedSender, getWindow, smokeExecutable }) => {
  const location = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'src', 'codex.mjs')
    : path.join(__dirname, '../../packages/runtime/src/codex.mjs');
  const { checkCodex } = await import(pathToFileURL(location).href);
  let executable = smokeExecutable;
  let pending;
  let abort;
  let closing = false;
  ipcMain.handle('agents:chooseCodex', async event => {
    if (!trustedSender(event) || closing) throw new Error('Connection request denied');
    if (pending) throw new Error('Wait for the current connection check to finish.');
    const result = await dialog.showOpenDialog(getWindow(), { title: 'Select your Codex executable', properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Codex executable', extensions: ['exe'] }] } : {}) });
    if (result.canceled) return null;
    executable = result.filePaths[0];
    return executable;
  });
  ipcMain.handle('agents:checkCodex', event => {
    if (!trustedSender(event) || closing) throw new Error('Connection request denied');
    if (!pending) {
      abort = new AbortController();
      pending = checkCodex({ executable, signal: abort.signal }).finally(() => { pending = null; });
    }
    return pending;
  });
  return { close: async () => { closing = true; abort?.abort(); await pending; } };
};
