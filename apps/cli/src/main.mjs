#!/usr/bin/env node
import { getStatus, version } from '../../../packages/runtime/src/index.mjs';

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.log(`Organis ${version}\n\nUsage: organis [--help | --version | status [--json]]\n\nBootstrap CLI. Agent execution is not implemented yet.`);
} else if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
  console.log(version);
} else if (args[0] === 'status' && (args.length === 1 || (args.length === 2 && args[1] === '--json'))) {
  const status = getStatus();
  console.log(args[1] === '--json' ? JSON.stringify(status) :
    `Organis ${status.version}\nStage: ${status.stage}\nPlatform: ${status.platform}/${status.arch}\nAgent runtime: not implemented`);
} else {
  console.error('Unknown command. Run organis --help.');
  process.exitCode = 2;
}
