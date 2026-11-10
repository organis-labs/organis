# Organis CLI manual

## Start here

Use `organis.cmd` on Windows or `./organis` on macOS and Linux from the extracted
release. The examples use `organis` on your PATH. In a source checkout, use
`npm run cli --` in place of `organis`.

```sh
organis --version
organis status
organis agent codex check
organis help agent codex check
```

Use `-h` or `--help` by itself or as the last option of a command. For example,
`organis agent codex check --json --help` still prints plain-text help. Help
does not run the requested command. Unknown help topics exit with code 2.
The CLI also accepts `-v` for `--version`.

## Codex connection check

```sh
organis agent codex check [--executable <absolute-path>] [--json]
```

Run `organis agent codex check --help` to see which Codex CLI versions your Organis
build accepts. The default is to find Codex on
`PATH`. If more than one copy is installed, pass its absolute path and quote it
if it contains spaces. Use the native `codex.exe` on Windows. Use a native Linux
binary inside WSL2. If Codex reports that you are signed out, run `codex login`
in your terminal and then repeat the check.

```powershell
organis.cmd agent codex check --executable "C:\Tools\Codex\codex.exe" --json
```

```sh
./organis agent codex check --executable /absolute/path/to/codex --json
```

| Exit code | Connection-check result |
| --- | --- |
| `0` | Passed discovery and the reported authentication check |
| `1` | Failed the check, for example missing executable or unsupported version |
| `2` | Invalid command or option |
| `130` | Interrupted |

With `--json`, a completed check emits one diagnostic object to stdout, even
when the check fails. Inspect `ok`, `code`, `version`, `authentication.status`
and `capabilities`. Argument errors go to stderr. Windows also reports Codex's
sandbox readiness. A successful check does not make a model request or prove
sandbox enforcement. Real task execution, interactive approval and session
resume are unavailable. See the [connection contract](specs/codex-connection-check.md)
for platform evidence and diagnostic behavior.

## Command reference

| Command | Purpose |
| --- | --- |
| `status [--json]` | Show Organis version, platform and feature availability without contacting Codex. |
| `project list` | List saved projects. |
| `project add <directory>` | Register an absolute project path on this host. |
| `project show <project-id>` | Show the project, registered paths and requested policy. |
| `project remove <project-id>` | Remove the project and its path registrations. |
| `project set-path <project-id> <path> [--access read\|write\|deny]` | Save requested access to an absolute path. The default is `read`. |
| `project remove-path <project-id> <path-id>` | Remove one path registration. |
| `run fixture --workspace <directory>` | Run the bundled deterministic test. Use a workspace you trust. |
| `run list` / `run show <run-id>` | List runs or inspect one run. |
| `run events <run-id> [--after <sequence>]` | Show events after an exclusive sequence cursor. |
| `run cancel <run-id> [--command-id <uuid>]` | Request cancellation. Use `run show` to check the result. |
| `run reconcile` | Reconcile interrupted runs. |
| `update [--check]` | Check the installed CLI for updates. Without `--check`, install an available update from a writable standalone bundle. |

All `project` and `run` commands accept `--state-dir <directory>` and `--json`.
The default state directory is `~/.organis/runtime`, shared with the desktop.
Project commands print JSON, formatted by default and compact with `--json`.
Fixture JSON output contains an acceptance record and a final result on separate
lines. Saved project access records are preferences.

The fixture accepts `--mode complete|fail|wait` (default `complete`),
`--duration <ms>` (default `250`), `--scope trusted-workspace` and
`--command-id <uuid>`. Reuse a command ID when reconciling a repeated
submission. See the [local execution contract](local-execution.md) for lifecycle
and recovery behavior, and the [CLI update instructions](../README.md#cli-updates)
for upgrade requirements.

## Help and documentation conventions

Command help gives a short description, usage, applicable options and a common
example where useful. The manual holds setup steps, command details, output and
exit-code contracts, and platform caveats. When adding an option, document its
value, default and side effects. Preserve stdout for structured command results
and use stderr for argument errors. Add flags such as dry-run or verbosity when
a command has corresponding behavior and users need to control it.

References: [Command Line Interface Guidelines](https://clig.dev/#help),
[GNU command-line conventions](https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces.html)
and the [GitHub CLI manual](https://cli.github.com/manual/).
