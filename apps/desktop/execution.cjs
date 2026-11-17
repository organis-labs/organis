// @ts-check
const { dialog, ipcMain } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createFileChangeController } = require('./file-change.cjs');

/**
 * @param {{ app: Electron.App, trustedSender: (event: Electron.IpcMainInvokeEvent) => boolean,
 * getWindow: () => Electron.BrowserWindow, stateDir?: string, smokeWorkspace?: string,
 * getCodexExecutable: () => string | undefined, getClaudeExecutable: () => string | undefined }} options
 */
exports.createExecutionController = async ({
  app, trustedSender, getWindow, stateDir, smokeWorkspace, getCodexExecutable, getClaudeExecutable
}) => {
  const location = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'src', 'execution.mjs')
    : path.join(__dirname, '../../packages/runtime/src/execution.mjs');
  /** @type {import('../../packages/runtime/src/execution.mjs').LocalRuntime} */
  let runtime;
  /** @type {ReturnType<typeof createFileChangeController>} */
  let fileChange;
  /** @type {import('./ipc-types.mjs').IpcHandlers<import('./ipc-types.mjs').CollaborationIpc> & {busy(): boolean, close(): Promise<void>}} */
  let collaboration;
  let standaloneStarts = 0;
  /** @type {Error | undefined} */
  let unavailable;
  /** @type {Error | undefined} */
  let collaborationUnavailable;
  try {
    const { LocalRuntime } = /** @type {typeof import('../../packages/runtime/src/execution.mjs')} */ (await import(pathToFileURL(location).href));
    runtime = new LocalRuntime({ stateDir, busyTimeoutMs: 250 });
    fileChange = createFileChangeController({ runtime, dialog, getWindow, getCodexExecutable });
    try {
      /** @param {string} name */
      const here = name => pathToFileURL(path.join(path.dirname(location), name)).href;
      const [{ createCollaboration, openCollaborationJournal }, { runClaudeTask }] = /** @type {[
        typeof import('../../packages/runtime/src/collaboration.mjs'), typeof import('../../packages/runtime/src/claude.mjs')
      ]} */ (await Promise.all([
        import(here('collaboration.mjs')), import(here('claude.mjs'))
      ]));
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
        inspect: (/** @type {string} */ projectId, /** @type {string} */ target) => runtime.inspectCodexFileChangeTarget(projectId, target),
        claude: (/** @type {NonNullable<Parameters<typeof runClaudeTask>[0]>} */ options) =>
          runClaudeTask({ ...options, executable: getClaudeExecutable() }),
        fileChange,
        verifyCodexTermination: async (/** @type {string | undefined} */ id, /** @type {string | undefined} */ commandId) => {
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
    const message = error instanceof Error ? error.message : String(error);
    unavailable = new Error(`Local execution is unavailable: ${message}. Your saved data was not reset. Check for an application update or repair the state directory.`);
  }
  /**
   * @template {unknown[]} Args
   * @template Result
   * @param {(...args: Args) => Result | Promise<Result>} action
   * @returns {(...args: Args) => Promise<Result>}
   */
  const standalone = action => async (/** @type {Args} */ ...args) => {
    if (collaboration?.busy()) throw new Error('Finish or cancel the current collaboration first.');
    standaloneStarts++;
    try { return await action(...args); }
    finally { standaloneStarts--; }
  };
  /** @type {string | undefined} */
  let workspace;
  /** @type {import('./ipc-types.mjs').IpcHandlers<import('./ipc-types.mjs').ExecutionIpc>} */
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
      return Reflect.apply(action, undefined, [input]);
    });
  }
  /** @satisfies {Record<keyof import('./ipc-types.mjs').CollaborationIpc, true>} */
  const collaborationChannels = {
    prepare: true, status: true, plan: true, propose: true, apply: true,
    review: true, revise: true, cancel: true, recordTest: true, dismiss: true
  };
  for (const name of /** @type {Array<keyof typeof collaborationChannels>} */ (Object.keys(collaborationChannels))) {
    ipcMain.handle(`collaboration:${name}`, (event, ...args) => {
      if (!trustedSender(event)) throw new Error('Collaboration request denied.');
      if (unavailable || collaborationUnavailable) throw unavailable ?? collaborationUnavailable;
      return Reflect.apply(collaboration[name], collaboration, args);
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
