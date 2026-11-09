import { checkCodex } from '../../../packages/runtime/src/codex.mjs';

export async function agentCommand(args) {
  const invalid = () => { throw Object.assign(new Error('Usage: organis agent codex check [--executable <absolute-path>] [--json]'), { code: 'INVALID_ARGUMENT' }); };
  if (args[0] !== 'codex' || args[1] !== 'check') invalid();
  let executable;
  let json = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--executable' && executable === undefined && args[i + 1] && !args[i + 1].startsWith('--')) executable = args[++i];
    else invalid();
  }
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'organis:interrupt']) process.on(name, interrupt);
  try {
    const result = await checkCodex({ executable, signal: abort.signal });
    console.log(json ? JSON.stringify(result) : `${result.version ? `Codex ${result.version}\n` : ''}${result.message}`);
    if (!result.ok) process.exitCode = result.code === 'CODEX_CHECK_CANCELLED' ? 130 : 1;
  } finally {
    for (const name of ['SIGINT', 'SIGTERM', 'organis:interrupt']) process.off(name, interrupt);
  }
}
