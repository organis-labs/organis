const { dialog, ipcMain } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

exports.registerProjectHandlers = ({ app, trustedSender, getWindow, stateDir, smokeWorkspace }) => {
  const location = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'src', 'projects.mjs')
    : path.join(__dirname, '../../packages/runtime/src/projects.mjs');
  let pending;
  const actions = {
    list: registry => registry.list(),
    preview: (registry, id) => registry.preview(id),
    pick: async (registry, { kind, projectId }) => {
      pending = undefined;
      if (!['project', 'file', 'directory'].includes(kind)) throw new Error('Invalid target kind.');
      const result = smokeWorkspace
        ? { canceled: false, filePaths: [kind === 'file' ? path.join(smokeWorkspace, 'context.txt') : smokeWorkspace] }
        : await dialog.showOpenDialog(getWindow(), {
          title: kind === 'project' ? 'Select a project directory' : 'Select a context path',
          properties: [kind === 'file' ? 'openFile' : 'openDirectory']
        });
      if (result.canceled) return null;
      const target = await registry.inspectPath(result.filePaths[0]);
      const token = randomUUID();
      pending = { token, target, projectId, kind };
      return { token, path: target.path, kind: target.kind };
    },
    save: (registry, { token, access }) => {
      if (!pending || pending.token !== token) throw new Error('Choose a path again.');
      const { target, projectId, kind } = pending;
      pending = undefined;
      return kind === 'project' ? registry.addProject(target.path, target)
        : registry.setPath(projectId, target.path, access, target);
    },
    removePath: (registry, { projectId, pathId }) => registry.removePath(projectId, pathId),
    removeProject: (registry, id) => registry.removeProject(id)
  };
  for (const [name, action] of Object.entries(actions)) {
    ipcMain.handle(`projects:${name}`, async (event, input) => {
      if (!trustedSender(event)) throw new Error('Project request denied.');
      const { ProjectRegistry } = await import(pathToFileURL(location).href);
      const registry = new ProjectRegistry(stateDir, { busyTimeoutMs: 250 });
      try { return await action(registry, input); }
      finally { registry.close(); }
    });
  }
};
