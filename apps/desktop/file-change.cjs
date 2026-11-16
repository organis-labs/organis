const { randomUUID } = require('node:crypto');

exports.createFileChangeController = ({ runtime, dialog, getWindow, getCodexExecutable }) => {
  let pending;

  async function discard() {
    const change = pending;
    if (!change) return false;
    if (change.cancellation) return change.cancellation;
    change.abort.abort(new Error('File change cancelled.'));
    change.cancellation = (async () => {
      const run = await change.launch?.catch(() => null);
      if (run) {
        runtime.discardCodexFileChange(run.id);
        if (!change.preview) {
          await runtime.cancel(run.id);
          const stopped = await runtime.wait(run.id);
          if (stopped.ownershipRetained) {
            throw new Error('File change discarded. Codex termination is unverified and the workspace remains busy.');
          }
        }
      }
      return true;
    })().finally(() => {
      if (pending === change) pending = undefined;
    });
    return change.cancellation;
  }

  return {
    discard,
    isPending: () => Boolean(pending),
    async start({ projectId, instructions } = {}, selection) {
      if (pending) throw new Error('Finish or cancel the current file change first.');
      if (typeof projectId !== 'string' || typeof instructions !== 'string' || !instructions.trim()) {
        throw new Error('Select a registered project and describe the change.');
      }
      const change = { id: randomUUID(), abort: new AbortController() };
      const { signal } = change.abort;
      pending = change;
      try {
        const picked = selection ? { filePaths: [selection.target] } : await dialog.showOpenDialog(getWindow(), {
          title: 'Select one existing text file in the project root',
          properties: ['openFile']
        });
        if (picked.canceled || signal.aborted) return null;
        change.launch = runtime.startCodexFileChange({
          projectId, target: picked.filePaths[0], instructions, executable: getCodexExecutable(), signal,
          expected: selection?.expected, commandId: selection?.commandId, roomId: selection?.roomId,
          participantId: selection?.participantId
        });
        const run = await change.launch;
        change.runId = run.id;
        try { selection?.onRun?.(run.id); }
        catch (error) {
          await discard();
          throw error;
        }
        if (signal.aborted) return null;
        const result = await runtime.wait(run.id);
        if (signal.aborted) return null;
        if (result?.ownershipRetained) {
          throw Object.assign(new Error('Codex termination is unverified and the workspace remains busy.'), { code: 'TERMINATION_UNVERIFIED' });
        }
        change.preview = { id: change.id, ...runtime.previewCodexFileChange(run.id) };
        return change.preview;
      } catch (error) {
        if (signal.aborted) return null;
        throw error;
      } finally {
        if (!change.preview) {
          if (change.runId) runtime.discardCodexFileChange(change.runId);
          if (pending === change && !change.cancellation) pending = undefined;
        }
      }
    },
    async approve(id, beforeApply) {
      const change = pending;
      if (!change?.preview || change.confirming || change.cancellation || change.id !== id) throw new Error('This proposal is no longer available.');
      change.confirming = true;
      const { signal } = change.abort;
      try {
        const confirmation = await dialog.showMessageBox(getWindow(), {
          type: 'question', message: 'Apply the reviewed change to this file?',
          detail: change.preview.target, buttons: ['Cancel', 'Apply change'], defaultId: 0, cancelId: 0,
          signal
        });
        if (confirmation.response !== 1 || signal.aborted) return false;
        beforeApply?.();
        await runtime.applyCodexFileChange(change.runId, { signal });
        return true;
      } catch (error) {
        if (signal.aborted) return false;
        throw error;
      } finally {
        runtime.discardCodexFileChange(change.runId);
        if (pending === change && !change.cancellation) pending = undefined;
      }
    }
  };
};
