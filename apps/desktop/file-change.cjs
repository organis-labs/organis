const { randomUUID } = require('node:crypto');

exports.createFileChangeController = ({ runtime, dialog, getWindow, getCodexExecutable }) => {
  let pending;

  async function discard() {
    const change = pending;
    if (!change) return false;
    pending = undefined;
    change.abort.abort(new Error('File change cancelled.'));
    if (change.runId) {
      runtime.discardCodexFileChange(change.runId);
      if (!change.preview) await runtime.cancel(change.runId);
    }
    return true;
  }

  return {
    discard,
    async start({ projectId, instructions } = {}) {
      if (pending) throw new Error('Finish or cancel the current file change first.');
      if (typeof projectId !== 'string' || typeof instructions !== 'string' || !instructions.trim()) {
        throw new Error('Select a registered project and describe the change.');
      }
      const change = { id: randomUUID(), abort: new AbortController() };
      const { signal } = change.abort;
      pending = change;
      try {
        const picked = await dialog.showOpenDialog(getWindow(), {
          title: 'Select one existing text file in the project root',
          properties: ['openFile']
        });
        if (picked.canceled || signal.aborted) return null;
        const run = await runtime.startCodexFileChange({
          projectId, target: picked.filePaths[0], instructions, executable: getCodexExecutable(), signal
        });
        change.runId = run.id;
        if (signal.aborted) {
          await runtime.cancel(run.id);
          return null;
        }
        await runtime.wait(run.id);
        if (signal.aborted) return null;
        change.preview = { id: change.id, ...runtime.previewCodexFileChange(run.id) };
        return change.preview;
      } catch (error) {
        if (signal.aborted) return null;
        throw error;
      } finally {
        if (!change.preview) {
          if (change.runId) runtime.discardCodexFileChange(change.runId);
          if (pending === change) pending = undefined;
        }
      }
    },
    async approve(id) {
      const change = pending;
      if (!change?.preview || change.confirming || change.id !== id) throw new Error('This proposal is no longer available.');
      change.confirming = true;
      const { signal } = change.abort;
      try {
        const confirmation = await dialog.showMessageBox(getWindow(), {
          type: 'question', message: 'Apply the reviewed change to this file?',
          detail: change.preview.target, buttons: ['Cancel', 'Apply change'], defaultId: 0, cancelId: 0,
          signal
        });
        if (confirmation.response !== 1 || signal.aborted) return false;
        await runtime.applyCodexFileChange(change.runId, { signal });
        return true;
      } catch (error) {
        if (signal.aborted) return false;
        throw error;
      } finally {
        runtime.discardCodexFileChange(change.runId);
        if (pending === change) pending = undefined;
      }
    }
  };
};
