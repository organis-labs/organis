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

contextBridge.exposeInMainWorld('organisExecution', Object.freeze({
  chooseWorkspace: () => ipcRenderer.invoke('execution:chooseWorkspace'),
  list: () => ipcRenderer.invoke('execution:list'),
  start: options => ipcRenderer.invoke('execution:start', options),
  startCodex: options => ipcRenderer.invoke('execution:startCodex', options),
  codexResult: id => ipcRenderer.invoke('execution:codexResult', id),
  events: id => ipcRenderer.invoke('execution:events', id),
  cancel: options => ipcRenderer.invoke('execution:cancel', options),
  reconcile: () => ipcRenderer.invoke('execution:reconcile')
}));

contextBridge.exposeInMainWorld('organisUpdates', Object.freeze({
  status: () => ipcRenderer.invoke('updates:status'),
  check: () => ipcRenderer.invoke('updates:check'),
  install: () => ipcRenderer.invoke('updates:install'),
  subscribe: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  }
}));

contextBridge.exposeInMainWorld('organisProjects', Object.freeze({
  list: () => ipcRenderer.invoke('projects:list'),
  preview: id => ipcRenderer.invoke('projects:preview', id),
  pick: input => ipcRenderer.invoke('projects:pick', input),
  save: input => ipcRenderer.invoke('projects:save', input),
  removePath: input => ipcRenderer.invoke('projects:removePath', input),
  removeProject: id => ipcRenderer.invoke('projects:removeProject', id)
}));
