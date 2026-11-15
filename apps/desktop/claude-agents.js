const checkClaudeButton = document.querySelector('#check-claude');
const chooseClaudeButton = document.querySelector('#choose-claude');
const terminalClaudeButton = document.querySelector('#claude-terminal');
const claudeStatus = document.querySelector('#claude-status');
const claudePath = document.querySelector('#claude-path');
const claudeCommands = document.querySelector('#claude-commands');
const claudeTerminalHelp = document.querySelector('#claude-terminal-help');
const claudeLoginCommand = document.querySelector('#claude-login-command');
const claudeAnswerCommand = document.querySelector('#claude-answer-command');

async function withClaudeControls(action) {
  checkClaudeButton.disabled = chooseClaudeButton.disabled = terminalClaudeButton.disabled = true;
  try {
    await action();
  } catch (error) {
    claudeStatus.textContent = error.message;
  } finally {
    checkClaudeButton.disabled = chooseClaudeButton.disabled = terminalClaudeButton.disabled = false;
  }
}

function showClaudeResult(result) {
  claudeStatus.textContent = result.version ? `Claude Code ${result.version}. ${result.message}` : result.message;
  if (result.executable) claudePath.textContent = result.executable;
}

checkClaudeButton.addEventListener('click', () => withClaudeControls(async () => {
  claudeStatus.textContent = 'Checking Claude Code…';
  showClaudeResult(await window.organisAgents.checkClaude());
}));

terminalClaudeButton.addEventListener('click', () => withClaudeControls(async () => {
  claudeCommands.hidden = true;
  claudeStatus.textContent = 'Preparing terminal commands…';
  const result = await window.organisAgents.claudeTerminal();
  showClaudeResult(result);
  if (result.login && result.firstAnswer) {
    claudeTerminalHelp.textContent = `Run each command separately in ${result.terminal}. The first answer appears there. After signing in, return here to check the connection.`;
    claudeLoginCommand.value = result.login;
    claudeAnswerCommand.value = result.firstAnswer;
    claudeCommands.hidden = false;
  }
}));

chooseClaudeButton.addEventListener('click', () => withClaudeControls(async () => {
  const selected = await window.organisAgents.chooseClaude();
  if (selected) {
    claudeCommands.hidden = true;
    claudePath.textContent = selected;
    claudeStatus.textContent = 'Executable selected. Check the connection or show the terminal commands.';
  }
}));
