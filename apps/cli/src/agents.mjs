import { checkCodex, loginCodex } from '../../../packages/runtime/src/codex.mjs';

export async function agentCommand(args) {
  const invalid = () => { throw Object.assign(new Error('Usage: organis agent codex check [--executable <absolute-path>] [--json] or organis agent codex login [--executable <absolute-path>] [--device-auth]'), { code: 'INVALID_ARGUMENT' }); };
  const login = args[1] === 'login';
  if (args[0] !== 'codex' || (!login && args[1] !== 'check')) invalid();
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
    const options = { executable, profile: 'cli', signal: abort.signal };
    const result = login ? await loginCodex({ ...options, deviceAuth, terminal: true }) : await checkCodex(options);
    console.log(json ? JSON.stringify(result) : login && result.ok ? 'ChatGPT is connected to Organis CLI.' :
      `${result.version ? `Codex ${result.version}\n` : ''}${result.message}`);
    if (!result.ok) process.exitCode = result.code === 'CODEX_CHECK_CANCELLED' ? 130 : 1;
  } finally {
    for (const name of ['SIGINT', 'SIGTERM', 'organis:interrupt', 'disconnect']) process.off(name, interrupt);
    process.off('message', control);
    if (process.connected) process.disconnect();
  }
}
