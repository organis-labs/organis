#!/usr/bin/env node
import { getStatus, version } from '../../../packages/runtime/src/index.mjs';

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.log(`Organis ${version}\n\nUsage:
  organis --version | status [--json] | update [--check]
  organis agent codex check [--executable <absolute-path>] [--json]
  organis run fixture --workspace <directory> [--mode complete|fail|wait]
      [--duration <ms>] [--command-id <uuid>] [--state-dir <directory>] [--json]
  organis run list|reconcile [--state-dir <directory>] [--json]
  organis run show|events|cancel <run-id> [--state-dir <directory>] [--json]
      events: [--after <sequence>]   cancel: [--command-id <uuid>]

Local execution foundation. Only the bundled deterministic fixture is supported.
Trusted workspace scope is not an OS sandbox. Codex connection checks do not start tasks.
Fixture --json emits an accepted record followed by a result; cancel acknowledges a request.
CLI and desktop share ~/.organis/runtime unless --state-dir is supplied.`);
} else if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
  console.log(version);
} else if (args[0] === 'status' && (args.length === 1 || (args.length === 2 && args[1] === '--json'))) {
  const status = getStatus();
  console.log(args[1] === '--json' ? JSON.stringify(status) :
    `Organis ${status.version}\nStage: ${status.stage}\nPlatform: ${status.platform}/${status.arch}\nLocal fixture execution: available\nCodex connection check: available; agent execution: not implemented`);
} else if (args[0] === 'agent') {
  try {
    const { agentCommand } = await import('./agents.mjs');
    await agentCommand(args.slice(1));
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
