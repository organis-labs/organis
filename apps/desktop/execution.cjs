const { dialog, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createFileChangeController } = require('./file-change.cjs');

exports.createExecutionController = async ({
  app, trustedSender, getWindow, stateDir, smokeWorkspace, getCodexExecutable, getClaudeExecutable
}) => {
  const location = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'src', 'execution.mjs')
    : path.join(__dirname, '../../packages/runtime/src/execution.mjs');
  let runtime;
  let fileChange;
  let collaboration;
  let standaloneStarts = 0;
  let unavailable;
  let collaborationUnavailable;
  try {
    const { LocalRuntime } = await import(pathToFileURL(location).href);
    runtime = new LocalRuntime({ stateDir, busyTimeoutMs: 250 });
    fileChange = createFileChangeController({ runtime, dialog, getWindow, getCodexExecutable });
    try {
      const here = name => pathToFileURL(path.join(path.dirname(location), name)).href;
      const [{ createCollaboration, openCollaborationJournal }, { runClaudeTask }] = await Promise.all([
        import(here('collaboration.mjs')), import(here('claude.mjs'))
      ]);
      collaboration = createCollaboration({
        journal: openCollaborationJournal(stateDir ?? app.getPath('userData')),
        selectFile: async () => {
          if (standaloneStarts || runtime.listRuns().some(run =>
            run.mode === 'codex-read-only' && (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state) || run.ownershipRetained))) {
            throw new Error('Finish or cancel the current Codex run first.');
          }
          const result = await dialog.showOpenDialog(getWindow(), {
            title: 'Select one existing text file in the project root', properties: ['openFile']
          });
          return result.canceled ? null : result.filePaths[0];
        },
        inspect: (projectId, target) => runtime.inspectCodexFileChangeTarget(projectId, target),
        claude: options => runClaudeTask({ ...options, executable: getClaudeExecutable() }),
        fileChange,
        verifyCodexTermination: async (id, commandId) => {
          if (!id) return false;
          await runtime.reconcile();
          const run = runtime.listRuns().find(run => run.id === id || run.commandId === commandId);
          if (!run) return true;
          return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state) && !run.ownershipRetained;
        }
      });
    } catch {
      collaborationUnavailable = new Error('Local collaboration is unavailable. Check the saved collaboration state or update Organis.');
    }
  } catch (error) {
    unavailable = new Error(`Local execution is unavailable: ${error.message}. Your saved data was not reset. Check for an application update or repair the state directory.`);
  }
  const standalone = action => async input => {
    if (collaboration?.busy()) throw new Error('Finish or cancel the current collaboration first.');
    standaloneStarts++;
    try { return await action(input); }
    finally { standaloneStarts--; }
  };
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
    start: standalone(async options => {
      if (!workspace) throw new Error('Select a workspace first.');
      if (!options || !['complete', 'fail', 'wait'].includes(options.mode)
          || typeof options.commandId !== 'string') throw new Error('Invalid fixture request.');
      return runtime.startFixture({ workspace, mode: options.mode, commandId: options.commandId, scope: 'trusted-workspace' });
    }),
    startCodex: standalone(async options => {
      if (!options || typeof options.projectId !== 'string' || typeof options.commandId !== 'string') {
        throw new Error('Select a registered project and enter a prompt.');
      }
      const { run: accepted } = await runtime.startCodex({
        projectId: options.projectId, prompt: options.prompt, commandId: options.commandId,
        executable: getCodexExecutable(), profile: 'desktop'
      });
      return accepted;
    }),
    codexResult: id => {
      const run = runtime.getRun(id);
      if (run.mode !== 'codex-read-only') throw new Error('Select a Codex run.');
      const answer = run.state === 'completed' ? runtime.events(id).find(event => event.type === 'codex_answer')?.text : undefined;
      const approval = run.state === 'awaiting_approval' ? runtime.pendingApproval(id) : null;
      return { state: run.state, answer, approval, errorCode: run.errorCode, ownershipRetained: run.ownershipRetained };
    },
    startFileChange: standalone(options => fileChange.start(options)),
    approveFileChange: standalone(id => fileChange.approve(id)),
    discardFileChange: standalone(() => fileChange.discard()),
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
  for (const name of ['prepare', 'status', 'plan', 'propose', 'apply', 'review', 'revise', 'cancel', 'recordTest', 'dismiss']) {
    ipcMain.handle(`collaboration:${name}`, (event, ...args) => {
      if (!trustedSender(event)) throw new Error('Collaboration request denied.');
      if (unavailable || collaborationUnavailable) throw unavailable ?? collaborationUnavailable;
      return collaboration[name](...args);
    });
  }
  return {
    cancelWindowActions: async () => {
      try {
        const status = await collaboration?.status();
        if (status && collaboration.busy()) await collaboration.cancel(status.id, status.attempt);
        else await fileChange?.discard();
      } catch { /* State and any unverified result remain in the journal. */ }
    },
    close: async () => {
      try { await collaboration?.close(); } finally {
        try { await fileChange?.discard(); } finally { await runtime?.close(); }
      }
    }
  };
};
