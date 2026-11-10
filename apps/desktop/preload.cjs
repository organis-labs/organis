const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('organisAgents', Object.freeze({
  chooseCodex: () => ipcRenderer.invoke('agents:chooseCodex'),
  checkCodex: () => ipcRenderer.invoke('agents:checkCodex')
}));

contextBridge.exposeInMainWorld('organisExecution', Object.freeze({
  chooseWorkspace: () => ipcRenderer.invoke('execution:chooseWorkspace'),
  list: () => ipcRenderer.invoke('execution:list'),
  start: options => ipcRenderer.invoke('execution:start', options),
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
