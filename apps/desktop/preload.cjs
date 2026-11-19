// @ts-check
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('organisAgents', Object.freeze({
  chooseCodex: () => ipcRenderer.invoke('agents:chooseCodex'),
  chooseClaude: () => ipcRenderer.invoke('agents:chooseClaude'),
  checkClaude: () => ipcRenderer.invoke('agents:checkClaude'),
  claudeTerminal: () => ipcRenderer.invoke('agents:claudeTerminal'),
  checkCodex: () => ipcRenderer.invoke('agents:checkCodex'),
  loginCodex: () => ipcRenderer.invoke('agents:loginCodex'),
  cancelLogin: () => ipcRenderer.invoke('agents:cancelLogin')
}));

// Electron's dynamic IPC boundary is narrowed to the shared channel contract.
const invoke = /** @type {import('./ipc-types.mjs').InvokeRuntime} */ (ipcRenderer.invoke.bind(ipcRenderer));

/** @type {import('./ipc-types.mjs').ExecutionIpc} */
const execution = {
  chooseWorkspace: () => invoke('execution:chooseWorkspace'),
  list: () => invoke('execution:list'),
  start: options => invoke('execution:start', options),
  startCodex: options => invoke('execution:startCodex', options),
  codexResult: id => invoke('execution:codexResult', id),
  startFileChange: options => invoke('execution:startFileChange', options),
  approveFileChange: id => invoke('execution:approveFileChange', id),
  discardFileChange: () => invoke('execution:discardFileChange'),
  events: id => invoke('execution:events', id),
  cancel: options => invoke('execution:cancel', options),
  reconcile: () => invoke('execution:reconcile')
};
contextBridge.exposeInMainWorld('organisExecution', Object.freeze(execution));

/** @type {import('./ipc-types.mjs').CollaborationIpc} */
const collaboration = {
  listRooms: () => invoke('collaboration:listRooms'),
  createRoom: name => invoke('collaboration:createRoom', name),
  openRoom: id => invoke('collaboration:openRoom', id),
  addParticipant: (id, provider) => invoke('collaboration:addParticipant', id, provider),
  prepare: input => invoke('collaboration:prepare', input),
  status: () => invoke('collaboration:status'),
  plan: (id, attempt) => invoke('collaboration:plan', id, attempt),
  propose: (id, attempt) => invoke('collaboration:propose', id, attempt),
  apply: (id, attempt) => invoke('collaboration:apply', id, attempt),
  review: (id, attempt) => invoke('collaboration:review', id, attempt),
  revise: (id, attempt) => invoke('collaboration:revise', id, attempt),
  cancel: (id, attempt) => invoke('collaboration:cancel', id, attempt),
  recordTest: input => invoke('collaboration:recordTest', input),
  dismiss: (id, attempt) => invoke('collaboration:dismiss', id, attempt)
};
contextBridge.exposeInMainWorld('organisCollaboration', Object.freeze(collaboration));

contextBridge.exposeInMainWorld('organisUpdates', Object.freeze({
  status: () => ipcRenderer.invoke('updates:status'),
  check: () => ipcRenderer.invoke('updates:check'),
  install: () => ipcRenderer.invoke('updates:install'),
  /** @param {(state: unknown) => void} callback */
  subscribe: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    /** @type {(_event: Electron.IpcRendererEvent, state: unknown) => void} */
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  }
}));

contextBridge.exposeInMainWorld('organisProjects', Object.freeze({
  list: () => ipcRenderer.invoke('projects:list'),
  /** @param {string} id */
  preview: id => ipcRenderer.invoke('projects:preview', id),
  /** @param {{kind: 'project' | 'file' | 'directory', projectId: string}} input */
  pick: input => ipcRenderer.invoke('projects:pick', input),
  /** @param {{token: string, access: 'read' | 'write' | 'deny'}} input */
  save: input => ipcRenderer.invoke('projects:save', input),
  /** @param {{projectId: string, pathId: string}} input */
  removePath: input => ipcRenderer.invoke('projects:removePath', input),
  /** @param {string} id */
  removeProject: id => ipcRenderer.invoke('projects:removeProject', id)
}));
