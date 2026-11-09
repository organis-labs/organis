const { dialog, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

exports.createExecutionController = async ({ app, trustedSender, getWindow, stateDir, smokeWorkspace }) => {
  const location = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'src', 'execution.mjs')
    : path.join(__dirname, '../../packages/runtime/src/execution.mjs');
  let runtime;
  let unavailable;
  try {
    const { LocalRuntime } = await import(pathToFileURL(location).href);
    runtime = new LocalRuntime({ stateDir, busyTimeoutMs: 250 });
  } catch (error) {
    unavailable = new Error(`Local execution is unavailable: ${error.message}. Your saved data was not reset. Check for an application update or repair the state directory.`);
  }
  let workspace;
  const actions = {
    chooseWorkspace: async () => {
      if (smokeWorkspace) workspace = smokeWorkspace;
      else {
        const result = await dialog.showOpenDialog(getWindow(), { title: 'Select a trusted workspace', properties: ['openDirectory'] });
        if (!result.canceled) workspace = result.filePaths[0];
      }
      return workspace ?? null;
    },
    list: () => runtime.listRuns().slice(0, 50),
    start: async options => {
      if (!workspace) throw new Error('Select a workspace first.');
      if (!options || !['complete', 'fail', 'wait'].includes(options.mode)
          || typeof options.commandId !== 'string') throw new Error('Invalid fixture request.');
      return runtime.startFixture({ workspace, mode: options.mode, commandId: options.commandId, scope: 'trusted-workspace' });
    },
    events: id => runtime.events(id),
    cancel: async options => {
      if (!options || typeof options.id !== 'string' || typeof options.commandId !== 'string') throw new Error('Invalid cancellation.');
      return runtime.cancel(options.id, { commandId: options.commandId });
    },
    reconcile: () => runtime.reconcile()
  };
  for (const [name, action] of Object.entries(actions)) {
    ipcMain.handle(`execution:${name}`, (event, input) => {
      if (!trustedSender(event)) throw new Error('Execution request denied');
      if (unavailable) throw unavailable;
      return action(input);
    });
  }
  return { close: async () => { await runtime?.close(); } };
};
