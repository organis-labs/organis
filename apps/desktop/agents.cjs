const { dialog, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

exports.createAgentController = async ({ app, trustedSender, getWindow, smokeExecutable }) => {
  const location = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'src')
    : path.join(__dirname, '../../packages/runtime/src');
  const [codex, claude] = await Promise.all([
    import(pathToFileURL(path.join(location, 'codex.mjs')).href),
    import(pathToFileURL(path.join(location, 'claude.mjs')).href)
  ]);
  let executable = smokeExecutable;
  let claudeExecutable = smokeExecutable;
  let pending;
  let abort;
  let closing = false;
  async function chooseExecutable(event, name) {
    if (!trustedSender(event) || closing) throw new Error('Connection request denied');
    if (pending) throw new Error('Wait for the current connection check to finish.');
    const result = await dialog.showOpenDialog(getWindow(), { title: `Select your ${name} executable`, properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: `${name} executable`, extensions: ['exe'] }] } : {}) });
    return result.canceled ? null : result.filePaths[0];
  }
  ipcMain.handle('agents:chooseCodex', async event => {
    const selected = await chooseExecutable(event, 'Codex');
    if (selected) executable = selected;
    return selected;
  });
  ipcMain.handle('agents:chooseClaude', async event => {
    const selected = await chooseExecutable(event, 'Claude');
    if (selected) claudeExecutable = selected;
    return selected;
  });
  const operations = {
    checkCodex: signal => codex.checkCodex({ executable, profile: 'desktop', signal }),
    loginCodex: signal => codex.loginCodex({ executable, profile: 'desktop', signal }),
    checkClaude: signal => claude.checkClaude({ executable: claudeExecutable, profile: 'desktop', signal }),
    claudeTerminal: signal => claude.claudeTerminalInstructions({ executable: claudeExecutable, profile: 'desktop', signal })
  };
  for (const [action, run] of Object.entries(operations)) {
    ipcMain.handle(`agents:${action}`, event => {
      if (!trustedSender(event) || closing) throw new Error('Connection request denied');
      if (pending) throw new Error('Wait for the current agent connection operation to finish.');
      abort = new AbortController();
      pending = run(abort.signal).finally(() => { pending = null; });
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
