
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const originalSpawn = childProcess.spawn;
const preload = import.meta.url;
const server = fileURLToPath(new URL('./codex-run-server.mjs', import.meta.url));
const scenario = process.env.ORGANIS_TEST_CODEX_SCENARIO;

childProcess.spawn = (file, args, options) => {
  if (args[0]?.endsWith('codex-run-process.mjs')) {
    return originalSpawn(file, ['--import', preload, ...args], {
      ...options, env: { ...options.env, ORGANIS_TEST_CODEX_SCENARIO: scenario }
    });
  }
  if (args[0] === 'app-server' || args[0] === '--version') {
    if (args[0] === 'app-server' && (!args.includes('--strict-config') || !args.includes('shell_tool')
        || !args.includes('hooks') || !args.includes('multi_agent') || !args.includes('web_search="disabled"'))) {
      throw new Error('Missing fixture policy flags');
    }
    return originalSpawn(file, [server, scenario, args[0]], options);
  }
  return originalSpawn(file, args, options);
};
syncBuiltinESMExports();
