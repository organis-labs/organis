import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export async function prepareCodexProfile(profile, env) {
  if (profile === undefined) return { env, args: [] };
  if (!['cli', 'desktop'].includes(profile)) throw new TypeError('Invalid Organis Codex profile.');
  const directory = path.join(homedir(), '.organis', 'codex', profile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'CODEX_HOME'));
  isolated.CODEX_HOME = directory;
  const args = process.platform === 'linux' ? [] : ['-c', 'cli_auth_credentials_store="keyring"'];
  if (process.platform === 'win32') args.push('-c', 'windows.sandbox="unelevated"');
  return { env: isolated, args };
}
