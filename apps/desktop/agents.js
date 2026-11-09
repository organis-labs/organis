const checkCodexButton = document.querySelector('#check-codex');
const chooseCodexButton = document.querySelector('#choose-codex');
const codexStatus = document.querySelector('#codex-status');
const codexPath = document.querySelector('#codex-path');
let checkingCodex = false;
checkCodexButton.addEventListener('click', async () => {
  if (checkingCodex) return;
  checkingCodex = true;
  checkCodexButton.disabled = chooseCodexButton.disabled = true;
  codexStatus.textContent = 'Checking Codex…';
  try {
    const result = await window.organisAgents.checkCodex();
    codexStatus.textContent = `${result.version ? `Codex ${result.version}. ` : ''}${result.message}`;
    if (result.executable) codexPath.textContent = result.executable;
  } catch { codexStatus.textContent = 'The connection check is unavailable. Restart Organis and try again.'; }
  finally { checkingCodex = false; checkCodexButton.disabled = chooseCodexButton.disabled = false; }
});
chooseCodexButton.addEventListener('click', async () => {
  if (checkingCodex) return;
  try {
    const selected = await window.organisAgents.chooseCodex();
    if (selected) { codexPath.textContent = selected; codexStatus.textContent = 'Executable selected. Choose Check connection to verify it.'; }
  } catch { codexStatus.textContent = 'Unable to select Codex. Try again after the current check finishes.'; }
});
