const execution = window.organisExecution;
const chooseWorkspace = document.querySelector('#choose-workspace');
const startFixture = document.querySelector('#start-fixture');
const fixtureMode = document.querySelector('#fixture-mode');
const executionStatus = document.querySelector('#execution-status');
const runsElement = document.querySelector('#runs');
let workspaceChosen = false;
let starting = false;
let refreshing = false;
let selectedId;
let commandId = crypto.randomUUID();
let lastSignature;
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

async function refreshRuns() {
  if (refreshing) return;
  refreshing = true;
  try {
    const runs = await execution.list();
    const signature = JSON.stringify(runs);
    if (signature !== lastSignature) {
      lastSignature = signature;
      const focusedRun = document.activeElement.closest('#runs li')?.dataset.runId;
      const focusedCancel = document.activeElement.classList.contains('cancel-run');
      runsElement.replaceChildren();
      for (const run of runs.slice(0, 50)) {
        const row = document.createElement('li');
        row.dataset.runId = run.id;
        row.dataset.state = run.state;
        const show = document.createElement('button');
        show.className = 'run-link';
        const stateLabel = run.ownershipRetained ? `${run.state} (termination unverified)` : run.state;
        show.textContent = `${stateLabel} · ${run.id.slice(0, 8)} · ${new Date(run.createdAt).toLocaleString()}`;
        show.addEventListener('click', async () => { selectedId = run.id; await showEvents(); });
        row.append(show);
        if (!terminalStates.has(run.state)) {
          const cancel = document.createElement('button');
          cancel.textContent = run.state === 'cancelling' ? 'Cancelling…' : 'Cancel';
          cancel.className = 'cancel-run';
          cancel.disabled = run.state === 'cancelling';
          cancel.addEventListener('click', async () => {
            cancel.disabled = true;
            try {
              await execution.cancel({ id: run.id, commandId: crypto.randomUUID() });
              executionStatus.textContent = 'Cancellation requested. Waiting for process termination.';
              await refreshRuns();
            } catch (error) { executionStatus.textContent = error.message; cancel.disabled = false; }
          });
          row.append(cancel);
        }
        runsElement.append(row);
      }
      if (focusedRun) {
        const row = runsElement.querySelector(`[data-run-id="${CSS.escape(focusedRun)}"]`);
        (focusedCancel ? row?.querySelector('.cancel-run:not(:disabled)') ?? row?.querySelector('.run-link') : row?.querySelector('.run-link'))?.focus();
      }
      if (selectedId) await showEvents();
    }
    if (!runs.length) executionStatus.textContent = 'No saved runs yet.';
    else if (executionStatus.textContent === 'Loading saved runs…') executionStatus.textContent = `${runs.length} saved run(s).`;
  } catch (error) { executionStatus.textContent = `Saved runs unavailable: ${error.message}`; }
  finally { refreshing = false; }
}

async function showEvents() {
  try { document.querySelector('#run-events').textContent = JSON.stringify(await execution.events(selectedId), null, 2); }
  catch (error) { executionStatus.textContent = error.message; }
}
chooseWorkspace.addEventListener('click', async () => {
  try {
    const selected = await execution.chooseWorkspace();
    if (selected) {
      document.querySelector('#workspace-path').textContent = selected;
      workspaceChosen = true;
      commandId = crypto.randomUUID();
      startFixture.disabled = starting;
    }
  } catch (error) { executionStatus.textContent = error.message; }
});
fixtureMode.addEventListener('change', () => { commandId = crypto.randomUUID(); });
startFixture.addEventListener('click', async () => {
  if (starting || !workspaceChosen) return;
  starting = true;
  startFixture.disabled = true;
  chooseWorkspace.disabled = true;
  fixtureMode.disabled = true;
  try {
    const result = await execution.start({ mode: fixtureMode.value, commandId });
    selectedId = result.run.id;
    commandId = crypto.randomUUID();
    executionStatus.textContent = `Run ${result.run.id.slice(0, 8)} acknowledged. Progress is saved locally.`;
    await refreshRuns();
  } catch (error) { executionStatus.textContent = error.message; }
  finally { starting = false; startFixture.disabled = false; chooseWorkspace.disabled = false; fixtureMode.disabled = false; }
});
document.querySelector('#reconcile-runs').addEventListener('click', async () => {
  try {
    await execution.reconcile();
    executionStatus.textContent = 'Reconciliation checked. Uncertain work is never restarted automatically.';
    await refreshRuns();
  } catch (error) { executionStatus.textContent = error.message; }
});
refreshRuns();
setInterval(refreshRuns, 500);
