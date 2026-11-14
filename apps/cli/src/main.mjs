#!/usr/bin/env node
import { getStatus } from '../../../packages/runtime/src/index.mjs';
import { getHelp } from './help.mjs';
import { version } from './version.mjs';

const args = process.argv.slice(2);
const help = getHelp(args);
if (help === null) {
  console.error('Unknown help topic. Run organis --help for available commands.');
  process.exitCode = 2;
} else if (help !== undefined) {
  console.log(help);
} else if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
  console.log(version);
} else if (args[0] === 'status' && (args.length === 1 || (args.length === 2 && args[1] === '--json'))) {
  const status = { ...getStatus(), version };
  console.log(args[1] === '--json' ? JSON.stringify(status) :
    `Organis ${status.version}\nStage: ${status.stage}\nPlatform: ${status.platform}/${status.arch}\nLocal fixture execution: available\nCodex connection check: available; agent execution: not implemented`);
} else if (['agent', 'project'].includes(args[0])) {
  try {
    if (args[0] === 'agent') {
      const { agentCommand } = await import('./agents.mjs');
      await agentCommand(args.slice(1));
    } else {
      const { projectCommand } = await import('./projects.mjs');
      await projectCommand(args.slice(1));
    }
  } catch (error) {
    const code = error.code ?? 'RUNTIME_ERROR';
    console.error(args.includes('--json') ? JSON.stringify({ type: 'error', code, message: error.message }) : `${code}: ${error.message}`);
    process.exitCode = code === 'INVALID_ARGUMENT' ? 2 : 1;
  }
} else if (args[0] === 'run' && args.length > 1) {
  try {
    const { executionCommand } = await import('./execution.mjs');
    await executionCommand(args.slice(1));
  } catch (error) {
    const code = error.code ?? 'RUNTIME_ERROR';
    if (args.includes('--json')) console.error(JSON.stringify({ type: 'error', code, message: error.message }));
    else console.error(`${code}: ${error.message}`);
    process.exitCode = code === 'INVALID_ARGUMENT' ? 2 : 1;
  }
} else if (args[0] === 'update' && (args.length === 1 || (args.length === 2 && args[1] === '--check'))) {
  try {
    const { updateCLI } = await import('./update.mjs');
    await updateCLI({ currentVersion: version, checkOnly: args[1] === '--check' });
  } catch (error) {
    console.error(`Update failed: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  console.error('Unknown command. Run organis --help.');
  process.exitCode = 2;
}
