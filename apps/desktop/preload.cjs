const { contextBridge, ipcRenderer } = require('electron');

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
