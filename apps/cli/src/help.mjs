import { testedCodexVersions } from '../../../packages/runtime/src/codex.mjs';
import { version } from './version.mjs';

const manual = 'https://github.com/organis-labs/organis/blob/main/docs/cli.md';
const codexUsage = 'organis agent codex check [--executable <absolute-path>] [--json]';
const codexHelp = `Check the installed Codex CLI and its reported sign-in state.
Supported Codex CLI: ${testedCodexVersions.join(', ')}.
This check does not run a task, verify sandbox enforcement, or handle approvals.

Usage:
  ${codexUsage}

Options:
  --executable <absolute-path>  Select Codex explicitly instead of searching PATH.
  --json                        Print one diagnostic JSON record on stdout.
  -h, --help                    Show this help.

Examples:
  organis agent codex check
  organis agent codex check --json

Sign in with codex login if needed, then repeat the check.
On Windows, select the native codex.exe instead of a .cmd or .bat wrapper.
Exit codes: 0 passed, 1 failed, 2 invalid arguments, 130 interrupted.`;

const sections = {
  '': `Organis ${version}

Usage:
  organis <command> [options]
  organis help [command ...]

Commands:
  status   Show the Organis version, platform and available features.
  agent    Check the installed Codex CLI and its reported sign-in state.
  project  Manage locally saved projects and requested path access.
  run      Run the built-in fixture and inspect saved runs.
  update   Check for or install a CLI update.

Options:
  -h, --help     Show help for Organis or a command.
  -v, --version  Print the Organis CLI version.

Get started:
  organis status
  organis agent codex check --help
  organis agent codex check --json

Codex connection checks support ${testedCodexVersions.join(', ')}.
Real Codex task execution and interactive approvals are unavailable.`,
  agent: codexHelp,
  'agent codex': codexHelp,
  'agent codex check': codexHelp,
  status: `Show local capabilities without contacting Codex.

Usage:
  organis status [--json]

Options:
  --json  Print one status JSON record on stdout.`,
  project: `Manage project registrations and requested path access.

Usage:
  organis project list
  organis project add <directory>
  organis project show <project-id>
  organis project remove <project-id>
  organis project set-path <project-id> <path> [--access read|write|deny]
  organis project remove-path <project-id> <path-id>

Options:
  --state-dir <directory>  Use a separate runtime state directory.
  --json                   Print compact JSON on stdout.
  --access <mode>          Requested access for set-path (default: read).

The default state directory is ~/.organis/runtime. Saved access is a preference.`,
  run: `Run a deterministic local fixture or manage saved runs.

Usage:
  organis run fixture --workspace <directory> [--mode complete|fail|wait]
      [--duration <ms>] [--scope trusted-workspace] [--command-id <uuid>]
  organis run list
  organis run show <run-id>
  organis run events <run-id> [--after <sequence>]
  organis run cancel <run-id> [--command-id <uuid>]
  organis run reconcile

Options:
  --state-dir <directory>  Use a separate runtime state directory.
  --json                   Print newline-delimited JSON on stdout.
  --duration <ms>          Fixture duration (default: 250).

Example:
  organis run fixture --workspace . --json

The fixture uses a trusted workspace. Cancel requests termination and does
not confirm it. Inspect the run with organis run show <run-id>.`,
  update: `Check for or install a CLI update.

Usage:
  organis update [--check]

Options:
  --check  Check for an update without installing it.

Installing requires the standalone CLI bundle and a writable install location.`
};

const groupedCommands = {
  project: new Set(['list', 'add', 'show', 'remove', 'set-path', 'remove-path']),
  run: new Set(['fixture', 'list', 'show', 'events', 'cancel', 'reconcile'])
};

export function getHelp(args) {
  let topic;
  if (args.length === 0) topic = [];
  else if (args[0] === 'help') topic = args.slice(1);
  else if (['-h', '--help'].includes(args.at(-1))) topic = args.slice(0, -1);
  else return undefined;

  const key = topic.join(' ');
  const section = Object.hasOwn(sections, key) ? sections[key]
    : topic.length === 2 && Object.hasOwn(groupedCommands, topic[0]) && groupedCommands[topic[0]].has(topic[1])
      ? sections[topic[0]] : null;
  return section === null ? null : `${section}\n\nManual: ${manual}`;
}
