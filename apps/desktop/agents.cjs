const { dialog, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

exports.createAgentController = async ({ app, trustedSender, getWindow, smokeExecutable }) => {
  const location = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'src', 'codex.mjs')
    : path.join(__dirname, '../../packages/runtime/src/codex.mjs');
  const { checkCodex, loginCodex } = await import(pathToFileURL(location).href);
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
  for (const [action, run] of Object.entries({ checkCodex, loginCodex })) {
    ipcMain.handle(`agents:${action}`, event => {
      if (!trustedSender(event) || closing) throw new Error('Connection request denied');
      if (pending) throw new Error('Wait for the current Codex operation to finish.');
      abort = new AbortController();
      pending = run({ executable, profile: 'desktop', signal: abort.signal }).finally(() => { pending = null; });
      return pending;
    });
  }
  ipcMain.handle('agents:cancelLogin', event => {
    if (!trustedSender(event) || closing) throw new Error('Connection request denied');
    abort?.abort();
  });
  return {
    getExecutable: () => executable,
    close: async () => { closing = true; abort?.abort(); await pending; }
  };
};
