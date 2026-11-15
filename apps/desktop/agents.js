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
const sendQuestion = document.querySelector('#send-codex');
const cancelQuestion = document.querySelector('#cancel-codex-turn');
const finished = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
let questionRunId;

questionForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (sendQuestion.disabled) return;
  const projectId = document.querySelector('#saved-project').value;
  if (!projectId) { questionStatus.textContent = 'Choose and register a project first.'; return; }
  const prompt = document.querySelector('#codex-prompt').value;
  sendQuestion.disabled = true;
  answerView.hidden = true;
  questionStatus.textContent = 'Starting Codex…';
  try {
    const run = await window.organisExecution.startCodex({ projectId, prompt, commandId: crypto.randomUUID() });
    questionRunId = run.id;
    cancelQuestion.hidden = false;
    cancelQuestion.disabled = false;
    let result;
    do {
      result = await window.organisExecution.codexResult(run.id);
      if (finished.has(result.state)) break;
      const status = result.state === 'awaiting_approval' ? 'Codex requested an action. You can cancel this read-only run.' :
        result.state === 'cancelling' ? 'Waiting for Codex to stop…' : 'Waiting for Codex…';
      if (questionStatus.textContent !== status) questionStatus.textContent = status;
      await new Promise(resolve => setTimeout(resolve, 500));
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
    cancelQuestion.hidden = true;
    sendQuestion.disabled = false;
  }
});

cancelQuestion.addEventListener('click', async () => {
  if (!questionRunId) return;
  cancelQuestion.disabled = true;
  try { await window.organisExecution.cancel({ id: questionRunId, commandId: crypto.randomUUID() }); }
  catch (error) { questionStatus.textContent = error.message; cancelQuestion.disabled = false; }
});
