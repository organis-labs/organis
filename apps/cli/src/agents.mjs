import { checkCodex, loginCodex } from '../../../packages/runtime/src/codex.mjs';
import { checkClaude, claudeTerminalInstructions } from '../../../packages/runtime/src/claude.mjs';

export async function agentCommand(args) {
  const [agent, action] = args;
  const login = agent === 'codex' && action === 'login';
  const terminal = agent === 'claude' && action === 'terminal';
  const invalid = () => { throw Object.assign(new Error('Invalid agent arguments. Run organis agent --help.'), { code: 'INVALID_ARGUMENT' }); };
  if (!login && !terminal && (!['codex', 'claude'].includes(agent) || action !== 'check')) invalid();
  let executable;
  let json = false;
  let deviceAuth = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--json' && !json && !login) json = true;
    else if (args[i] === '--device-auth' && !deviceAuth && login) deviceAuth = true;
    else if (args[i] === '--executable' && executable === undefined && args[i + 1] && !args[i + 1].startsWith('--')) executable = args[++i];
    else invalid();
  }
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'organis:interrupt', 'disconnect']) process.on(name, interrupt);
  const control = message => { if (message?.type === 'organis:interrupt') interrupt(); };
  process.on('message', control);
  if (process.connected) process.send({ type: 'organis:control-ready' }, () => {});
  try {
    const options = { executable, signal: abort.signal, profile: 'cli' };
    const result = login ? await loginCodex({ ...options, deviceAuth, terminal: true }) :
      await (terminal ? claudeTerminalInstructions(options) : agent === 'claude' ? checkClaude(options) : checkCodex(options));
    if (result.login && result.firstAnswer) {
      console.log(json ? JSON.stringify(result) :
        `Run each command separately in ${result.terminal}. Sign in first if needed.\n\n${result.login}\n\n${result.firstAnswer}`);
      return;
    }
    const label = agent === 'claude' ? 'Claude Code' : 'Codex';
    console.log(json ? JSON.stringify(result) : login && result.ok ? 'ChatGPT is connected to Organis CLI.' :
      `${result.version ? `${label} ${result.version}\n` : ''}${result.message}`);
    if (!result.ok) process.exitCode = ['CODEX_CHECK_CANCELLED', 'CLAUDE_CHECK_CANCELLED'].includes(result.code) ? 130 : 1;
  } finally {
    for (const name of ['SIGINT', 'SIGTERM', 'organis:interrupt', 'disconnect']) process.off(name, interrupt);
    process.off('message', control);
    if (process.connected) process.disconnect();
  }
}
