
# Codex read-only CLI preview

R04 supports one ephemeral Codex 0.164.0 turn from the CLI or desktop. The project ID
selects a trusted, registered, host-local working directory. The registry's
workspace-write settings remain preferences. This preview supplies its own fixed
policy and rejects registrations with additional path rules.

## First login and first answer

The CLI's `organis agent codex login` and desktop's **Sign in to Codex** invoke
the installed Codex CLI's official login. Codex owns the callback and stores
its credentials in the OS keyring on Windows and macOS. The CLI and desktop use
separate Codex homes under `~/.organis/codex`. The child environment selects the
appropriate home for login, connection checks and runs. The user can opt into
Codex device-code login through the CLI for a headless host.

Register and select a trusted project. Use `organis run codex` or the desktop's
**Ask Codex** form to send a prompt. Desktop displays the saved answer after
confirmed completion and can cancel via the same local runtime. On Windows both
profiles select Codex's non-admin sandbox and still require readiness. Missing
sign-in, unsupported executables and sandbox or turn failures are reported
without returning the login response or credential data. Each prompt starts a
new turn in a new ephemeral thread.

## Execution and records

- The coordinator takes the same workspace lease used by fixture runs and
  checks the filesystem identity. A local worker uses the installed native
  executable and the client's isolated ChatGPT sign-in. A Windows provider must
  report that its sandbox is ready. The runtime never imports login files.
- The worker sets an explicit read-only sandbox, disables command network access,
  and accepts no expansion of authority. It starts the turn only after the
  provider echoes the expected policy and project directory. Use trusted
  projects and a stable, compatible Codex configuration. The preview disables
  hooks, shell tools, plugins, apps and subagents. It blocks configured MCP
  definitions before launching a thread and checks again before sending the prompt.
  The app-server may reload settings while opening the thread, so do not change
  Codex or project configuration while the preview is running.
  Model requests still go to the Codex provider. The preview is intended for
  text tasks and offers no per-file access or registered-path isolation.
- The original SQLite database records the run, ordered events, provider thread
  and turn IDs, and up to 32,768 characters of the final answer on success. It
  does not save the prompt as a separate field or retain raw protocol, stderr,
  account details or approval payloads. The submission digest includes the prompt.
  A model answer can repeat its input.
  Process arguments and the provider have their own privacy properties.
- The coordinator claims the run before process launch and persists worker and
  provider process identity. Completion requires a matching terminal turn and
  confirmed process exit. A cancellation requests turn interruption and waits for
  cleanup. An unconfirmed stop is reported as interrupted or still cancelling.
  Owner loss without a recorded clean shutdown, unknown process identity and
  unexpected tool execution retain the workspace
  lease. Reconciliation never signals stored PIDs or relaunches a run.
  If containment was lost, automatic reconciliation cannot clear that lease by
  observing only the recorded processes. Check the app-server and its
  descendants on the host. Once their termination is known, a separate
  `--state-dir` can be used while preserving the interrupted run's record.

## Pending requests and denial

If the verified provider requests a command, file change or additional permissions,
the owner records `approval_requested` and enters `awaiting_approval` without
releasing the workspace. A request record stores an Organis ID and method. The
provider's request ID stays in the active worker. While a request is pending,
the owner's UI can show a bounded preview of commands, target paths, and the
patch when Codex supplied it for the same item and turn. Desktop shows
**Requested action**. Start the owning CLI with `--show-approval` to display
the preview, which may contain sensitive text. The coordinator keeps previews
in memory. Saved events and other processes do not receive that text. An
incomplete preview cannot establish an exact action. The CLI can deny the
request identified by the saved ID.

The run state transition and `approval_denied` event commit together. The owner
then sends the bound negative response. Command and file requests receive a
decline. Permission requests receive an empty turn-scoped permission object.
An accepted CLI denial confirms the record, while provider delivery is separate.
If IPC delivery fails, the owner records `approval_denial_delivery_failed`
and stops the worker without replaying the decision.
Competing or stale requests to deny the same ID fail. Another simultaneous
provider request or an invalid binding stops the session.

Cancelling the run invalidates a pending request atomically before asking the
worker to interrupt the turn. The run deadline, unexpected turn termination
and owner loss also invalidate pending requests. Recovery does not replay
provider responses. Unverified termination continues to hold the workspace.

Both clients use the provider's `never` approval policy and the read-only
sandbox. Authority grants and writable execution remain separate R04 work. The
CLI can explicitly deny a pending request. Desktop can cancel the run. CI
exercises approval requests with a synthetic app-server.
