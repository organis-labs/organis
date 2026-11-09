# Codex connection check (R03)

Status: implemented connection check; real task execution (R04/M2) is not enabled.
Decision and protocol evidence: [first adapter](../decisions/first-agent-adapter.md).

## User flow

Run `organis agent codex check [--executable <absolute-path>] [--json]`, or choose
**Check connection** in the desktop app. An explicit desktop executable selection
lasts for that application session; it is not a portable setting or a registration
in a room. No check runs automatically on app startup. Repeated check clicks share
one pending request. Selecting a file does not execute it until the check starts.

PATH lookup ignores relative/empty entries. Windows uses native `codex.exe`;
`.cmd`/`.bat` wrappers are reported as unsupported instead of passing them to a
shell. Select the native executable from the installed Codex distribution. On
macOS/Linux, PATH lookup uses executable `codex`. A GUI app can have a different
PATH from a terminal; use the executable picker in that case. Selected programs
must be trusted, as with any local CLI installation.
An npm launcher also needs Node on that PATH; selecting Codex's native binary
avoids this extra GUI environment dependency.

## Contract

The shared runtime module performs these steps with a temporary empty working
directory and an allowlisted environment:

1. Discover the executable and run `--version` without a shell.
2. Require exactly the tested stable version, currently **0.164.0**. Other versions
   stop before an app-server starts. This is a tested compatibility set, not a
   claim that other versions are defective.
3. Start `app-server --stdio`; disable apps, plugins, hooks, native multi-agent
   support and daemon auto-start for this check. Use stable protocol capabilities.
4. `initialize`, notify `initialized`, then `account/read` with
   `refreshToken: false`. On Windows also read `windowsSandbox/readiness`.
5. Close stdin and wait for process closure. A timeout/cancellation kills only the
   live child handle owned by this invocation; no stored PID is signalled. A forced
   shutdown after an otherwise successful check invalidates the success result.

Child-process communication has a 15-second deadline and bounded shutdown waits.
Filesystem discovery can also wait for OS path I/O, particularly for disconnected
network paths; cancellation is checked before launching a process. Its
combined provider output limit is 1 MiB. Malformed output, unknown authentication
types, failed requests, timeouts and abnormal exits produce fixed diagnostic codes
and messages. Provider stderr, account email, plan details and error text are not
returned. The returned executable path is local diagnostic information.

`ok: true` means the discovery protocol and reported authentication state passed;
it does not validate token expiry by making a model request. `authentication.kind`
reports Codex's `chatgpt` or `apiKey` mode. A provider that reports authentication
unnecessary is represented separately. When authentication is needed, users run
`codex login` through Codex's own terminal flow, then repeat the check. Organis does
not run login/logout, read token files, import caches, accept an API key, or inherit
API key environment variables. It retains `CODEX_HOME` when explicitly present so
Codex can locate its own installation state.

The check never calls `thread/start`, `turn/start`, a tool, approval, login or
configuration write. Unexpected server requests are rejected. It does not acquire
a workspace lease, create a run, or change the SQLite schema. Provider-owned
startup caches/logs may still be maintained by Codex itself.

The result always reports `taskExecution: false`, `interactiveApproval: false`,
and `resume: false`. Windows sandbox readiness is only a provider-reported setup
status; neither it nor a successful check proves task containment. Other OSes
report `not-checked` for this field.

CLI JSON output is one result on stdout with exit code 0 for a successful check,
1 for a failed check, and 130 for interruption. Argument errors use stderr and
exit code 2. Desktop IPC accepts no renderer-provided command/path arguments;
selection happens in the main process's file dialog, with the existing trusted
sender/frame check. Quitting waits for any pending connection check to close.

## Acceptance and limitations

- Synthetic child-process tests cover success, unsupported versions, missing and
  invalid paths, signed-out/unknown authentication, malformed/oversized output,
  RPC failure, abnormal exit, deadline, cancellation and environment filtering.
- Desktop package smoke uses a missing executable to verify renderer -> trusted
  IPC -> packaged runtime -> visible error, without requiring an account or a
  provider installation. CLI tests run without Electron or a display.
- Windows live verification with installed Codex 0.164.0 passed discovery, reported
  ChatGPT sign-in and sandbox readiness, and clean process exit.
- Ubuntu 24.04 x64 under WSL2 passed the CLI connection check after Codex's own
  device login. The actual Electron 45.2.3 desktop connection button also passed,
  without sandbox-disabling flags and with renderer Node access absent. Both used
  source revision `e1988af9bad8ada081ed847de2e19d668b26220d`, Node 24.22.2 and the
  official Linux Codex 0.164.0 binary. All 68 tests passed on this environment.
  WSL2 is not bare-metal Linux acceptance. Native CI checks implementation and
  packages with synthetic protocol responses; it does not use provider accounts.
- Resuming sessions, interactive approvals, scoped file changes, general agent
  execution and strong child-process containment remain R04 work.
