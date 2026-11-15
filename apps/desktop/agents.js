const checkCodexButton = document.querySelector('#check-codex');
const chooseCodexButton = document.querySelector('#choose-codex');
const codexStatus = document.querySelector('#codex-status');
const codexPath = document.querySelector('#codex-path');
const loginCodexButton = document.querySelector('#login-codex');
const cancelLoginButton = document.querySelector('#cancel-codex-login');
let checkingCodex = false;
async function connectCodex(login) {
  if (checkingCodex) return;
  checkingCodex = true;
  loginCodexButton.disabled = checkCodexButton.disabled = chooseCodexButton.disabled = true;
  cancelLoginButton.hidden = !login;
  codexStatus.textContent = login ? 'Complete Codex sign-in in your browser.' : 'Checking Codex…';
  try {
    const result = await (login ? window.organisAgents.loginCodex() : window.organisAgents.checkCodex());
    codexStatus.textContent = login && result.ok ? 'ChatGPT is connected to Organis Desktop.' :
      `${result.version ? `Codex ${result.version}. ` : ''}${result.message}`;
    if (result.executable) codexPath.textContent = result.executable;
  } catch { codexStatus.textContent = 'The Codex connection is unavailable. Restart Organis and try again.'; }
  finally {
    checkingCodex = false;
    cancelLoginButton.hidden = true;
    loginCodexButton.disabled = checkCodexButton.disabled = chooseCodexButton.disabled = false;
  }
}
checkCodexButton.addEventListener('click', () => connectCodex(false));
loginCodexButton.addEventListener('click', () => connectCodex(true));
cancelLoginButton.addEventListener('click', () => {
  window.organisAgents.cancelLogin().catch(() => { codexStatus.textContent = 'Unable to cancel sign-in.'; });
});
chooseCodexButton.addEventListener('click', async () => {
  if (checkingCodex) return;
  try {
    const selected = await window.organisAgents.chooseCodex();
    if (selected) { codexPath.textContent = selected; codexStatus.textContent = 'Executable selected. Choose Check connection to verify it.'; }
  } catch { codexStatus.textContent = 'Unable to select Codex. Try again after the current check finishes.'; }
});

const questionForm = document.querySelector('#codex-question');
const questionStatus = document.querySelector('#codex-turn-status');
const answerView = document.querySelector('#codex-answer');
const approvalView = document.querySelector('#codex-approval');
const approvalDetails = document.querySelector('#codex-approval-details');
const sendQuestion = document.querySelector('#send-codex');
const cancelQuestion = document.querySelector('#cancel-codex-turn');
const finished = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
let questionRunId;
let questionActionError = false;

function formatApproval({ approvalId, method, preview }) {
  const lines = [`Request ID: ${approvalId}`, `Request type: ${method}`];
  if (!preview) return [...lines, 'No action preview is available.'].join('\n');
  if (preview.cwd) lines.push(`Working directory: ${preview.cwd}`);
  if (preview.command) lines.push('', preview.command);
  if (preview.requestedRoot) lines.push(`Requested root: ${preview.requestedRoot}`);
  for (const target of preview.targets ?? []) lines.push(`${target.action} ${target.path}`);
  for (const entry of preview.paths ?? []) lines.push(`${entry.access} ${entry.path}`);
  if (preview.networkRequested) lines.push('Network access requested.');
  for (const change of preview.changes ?? []) {
    lines.push('', `${change.action} ${change.path}${change.moveTo ? ` → ${change.moveTo}` : ''}`);
    if (change.diff) lines.push(change.diff);
  }
  if (preview.incomplete) lines.push('', 'Codex did not provide a complete action preview.');
  return lines.join('\n');
}

questionForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (sendQuestion.disabled) return;
  const projectId = document.querySelector('#saved-project').value;
  if (!projectId) { questionStatus.textContent = 'Choose and register a project first.'; return; }
  const prompt = document.querySelector('#codex-prompt').value;
  sendQuestion.disabled = true;
  questionActionError = false;
  answerView.hidden = true;
  questionStatus.textContent = 'Starting Codex…';
  try {
    const run = await window.organisExecution.startCodex({ projectId, prompt, commandId: crypto.randomUUID() });
    questionRunId = run.id;
    cancelQuestion.hidden = false;
    cancelQuestion.disabled = false;
    let result;
    do {
      result = await window.organisExecution.codexResult(run.id).catch(() => null);
      if (result && finished.has(result.state)) break;
      approvalView.hidden = !result?.approval;
      const details = result?.approval ? formatApproval(result.approval) : '';
      if (approvalDetails.textContent !== details) approvalDetails.textContent = details;
      const status = !result ? 'Unable to check this run. Retrying…' :
        result.state === 'awaiting_approval' ? 'Codex requested an action. You can cancel this read-only run.' :
        result.state === 'cancelling' ? 'Waiting for Codex to stop…' : 'Waiting for Codex…';
      if (!questionActionError && questionStatus.textContent !== status) questionStatus.textContent = status;
      await new Promise(resolve => setTimeout(resolve, result ? 500 : 1000));
    } while (true);
    if (result.state === 'completed') {
      questionStatus.textContent = result.answer ? 'Answer received.' : 'Codex completed without a text answer.';
      answerView.textContent = result.answer ?? '';
      answerView.hidden = !result.answer;
    } else {
      questionStatus.textContent = result.errorCode === 'CODEX_AUTH_REQUIRED' ? 'Sign in to Codex and send the question again.' :
        `Run ${result.state}${result.errorCode ? ` (${result.errorCode})` : ''}.${result.ownershipRetained ? ' Termination is unverified.' : ''}`;
    }
  } catch (error) {
    questionStatus.textContent = error.message;
  } finally {
    questionRunId = undefined;
    approvalView.hidden = true;
    approvalDetails.textContent = '';
    cancelQuestion.hidden = true;
    sendQuestion.disabled = false;
  }
});

cancelQuestion.addEventListener('click', async () => {
  const runId = questionRunId;
  if (!runId || cancelQuestion.disabled) return;
  cancelQuestion.disabled = true;
  questionActionError = false;
  questionStatus.textContent = 'Requesting cancellation…';
  try { await window.organisExecution.cancel({ id: runId, commandId: crypto.randomUUID() }); }
  catch (error) {
    if (questionRunId !== runId) return;
    questionActionError = true;
    questionStatus.textContent = error.message;
    cancelQuestion.disabled = false;
  }
});
