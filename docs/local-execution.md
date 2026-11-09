# Local execution contracts (M1)

Status: M1 implementation of `packages/runtime/src/execution.mjs`. This document is the
contract for clients (CLI, desktop, future mobile). Code lives in
`packages/runtime/src/` and has no Electron dependency.

## Scope and non-goals

- The runtime launches **only a bundled deterministic fixture**
  (`fixture-process.mjs`). It is not an agent and not a general command runner. There is no
  option to pass a command, executable, arguments, environment, shell or cwd; such keys are
  rejected with `INVALID_ARGUMENT`.
- The only capability is `organis.fixture` with scope `trusted-workspace`. There is **no OS
  sandbox, no network isolation and no filesystem isolation**. Requests that ask for any of
  them (`sandbox`, `network`, `networkPolicy`, `isolation` options, or a scope matching
  `sandbox|isolat|network`) are rejected with `SANDBOX_UNSUPPORTED` instead of being silently
  weakened. A git worktree is a checkout, not a sandbox.
- Any other scope is rejected with `SCOPE_DENIED`.
- Non-goals for M1: real agent tools, approvals, rooms/messages, remote hosts, artifacts,
  parallel writers on one checkout, automatic retry.

## Public API

```
defaultStateDir()          // <home>/.organis/runtime
new LocalRuntime({ stateDir, busyTimeoutMs, staleAfterMs = 10000, heartbeatMs = 1000 })
  startFixture({ workspace, commandId, mode = 'complete', durationMs = 250,
                 scope = 'trusted-workspace', roomId, participantId })
                                           -> { run, duplicate }   // returns while the run is queued
  getRun(id) | listRuns() | events(id, after = 0)
  wait(id, { timeoutMs })  cancel(id, { commandId })  reconcile()  close()
```

- `mode`: `complete`, `fail`, `wait` (runs until cancelled). `durationMs`: integer 0..30000.
- `commandId`, `roomId`, `participantId` are optional UUIDs; missing ones are generated.
- `getRun` and `listRuns` (newest first) return camelCase snapshots; `events` returns
  `{ sequence, runId, type, at, ...data }` in ascending order, `after` exclusive.
- Failures throw `RuntimeError` with `.code` and `.retryable`.
- `wait()` has no default timeout for an owned run; observing another owner's run defaults
  to 60 seconds. Clients may provide `timeoutMs` explicitly.
- All validation (arguments, scope, workspace) happens before any database write or spawn.
- Workspace rules: absolute, existing directory, resolved with `realpath`. Denied with
  `SCOPE_DENIED`: a filesystem root, the user home directory itself, the runtime state
  directory, anything inside it, and any ancestor of it.
- After `close()` every call throws `RUNTIME_CLOSED`.

## Run states

| State | M1 status | Meaning |
| --- | --- | --- |
| `queued` | implemented | Accepted and persisted; not yet spawned. |
| `running` | implemented | Fixture process observed running. |
| `awaiting_approval` | **contract-only** | No M1 code path enters it. |
| `cancelling` | implemented | Cancel requested; not yet verified dead. |
| `completed` | implemented, terminal | Process exited 0 with an `ok` result and the process tree verified dead. |
| `failed` | implemented, terminal | Non-success exit, spawn failure, or fixture failure. |
| `cancelled` | implemented, terminal | Cancel requested and process exit verified. |
| `interrupted` | implemented, terminal | Owner lost or persistence failed; outcome uncertain. |

Live states: `queued`, `running`, `awaiting_approval`, `cancelling`. All others are terminal.

| From | Allowed to |
| --- | --- |
| `queued` | `running`, `cancelling`, `cancelled`, `failed`, `interrupted` |
| `running` | `awaiting_approval`, `completed`, `failed`, `cancelling`, `interrupted` |
| `awaiting_approval` | `running`, `cancelling`, `failed`, `interrupted` |
| `cancelling` | `cancelled`, `interrupted` |
| terminal states | none |

`assertTransition(from, to)` throws `INVALID_TRANSITION`. Every state change and its event are
written in one `BEGIN IMMEDIATE` transaction. Updates are conditional on the expected prior
state and owner, so a concurrent change (for example another client requesting cancel) cannot
be overwritten by a stale completion. `approvalState` is always `not_required` in M1; the
approval states `pending`, `approved`, `rejected`, `expired` are contract-only.

## Event types

`run_created`, `launch_requested`, `process_started`, `fixture_ready`, `cancel_requested`, `cancelled`,
`cancel_unverified`, `completed`, `failed`, `interrupted`, `owner_suspect`,
`ownership_retained`, `ownership_released`.

- Event `sequence` is a single global, monotonically increasing integer
  (`AUTOINCREMENT`). It is the exclusive resume cursor: a client keeps the last sequence it
  saw and calls `events(id, after)`.
- `launch_requested` is committed before spawning, so missing process identity cannot be
  mistaken for proof that nothing started.
- `fixture_ready` carries the process ids, canonical working directory and the **names** of the fixture environment
  variables, never values. No process stdout/stderr is captured or stored.
- Events are execution events. They are not room messages.

## Ownership

- Each `LocalRuntime` that starts a run registers an **owner lease** row
  (`owners`: id, pid, hostname, start time, heartbeat, closed_at) in the same transaction as
  the run it creates. Reader-only clients never register and never own anything.
- One live writer per canonical workspace: `workspaces.busy_run_id` plus a `file_id`
  (`dev:ino`) alias guard are checked and set inside an `IMMEDIATE` transaction, so two
  processes (or two paths aliasing one directory, including case or symlink aliases) cannot
  both start. The loser gets `WORKSPACE_BUSY`. There is no automatic reconcile-and-retry on
  busy.
- `commandId` is unique per runtime state (`commands` table); see deduplication below.
- A live owner is never stolen. Another client may only request cancellation, which the owner
  performs. Only the owner process spawns, kills or finalizes its runs.
- The owner writes a heartbeat about every `heartbeatMs`. A stale heartbeat with a live
  owner pid is **not** treated as death; it only appends one `owner_suspect` event per run.

## Storage decision

- `node:sqlite` (`DatabaseSync`) at `<stateDir>/runtime.sqlite`, directory mode `0700` on
  POSIX, WAL journal, `synchronous=FULL`, and `busy_timeout` (default 5000 ms,
  `busyTimeoutMs`). Desktop uses 250 ms to bound each synchronous database lock wait;
  heavy database work can still block its main process in M1.
- Schema version is `PRAGMA user_version` (currently 1). Opening a database with a newer
  version closes it and throws `SCHEMA_TOO_NEW` without writing anything. A new database
  creates its schema and sets the version in one transaction.
- Why not JSON files: multiple processes (CLI, desktop, a future relay) need atomic
  multi-record updates, a global event sequence, uniqueness constraints for command ids and
  workspace ownership, and crash safety. Scattered unversioned JSON would need hand-rolled
  locking and gives none of these.
- Tables: `owners`, `workspaces`, `runs`, `commands`, `events`.

## Crash, restart and recovery

- Constructing a `LocalRuntime` calls `reconcile()`. It examines runs owned by other owners
  in a live state, and `interrupted` runs that still retain ownership.
- A run is `interrupted` with `errorCode: OWNER_LOST` when its owner row is missing, closed,
  or its pid is not alive. It is never marked `completed` or `cancelled` by recovery, and is
  **never retried or relaunched**.
- After an interrupt the recorded process and grandchild pids are checked. If either is still
  alive the run keeps `ownershipRetained: true`, the workspace stays busy, and a new start on
  it fails with `WORKSPACE_BUSY`. When both are gone a later `reconcile()` sets
  `ownershipRetained: false`, releases the workspace and appends `ownership_released`.
- If `launch_requested` exists without a persisted `fixture_ready`, the launched tree is
  unknown. Ownership stays retained even if a recorded pid is absent or dead. M1 has no
  automatic reset or force-release command for this case; operator investigation is required.
  Removing state is not evidence that the old process tree stopped.
- An observed child exit whose descendants cannot be confirmed stopped becomes
  `interrupted` with `TERMINATION_UNVERIFIED`, also retaining workspace ownership.
- Recovered pids are **never killed**. A pid recorded by a dead owner may have been reused by
  an unrelated process; killing it would be unsafe. Liveness checks are
  `process.kill(pid, 0)` only. This has a known limitation: a reused pid makes a dead run look
  alive, which keeps the workspace busy until that process exits (fail-safe, but it needs
  operator attention).
- The fixture exits by itself when its IPC channel to the owner closes, so a crashed owner
  normally takes its fixture down.

## Persistence-failure semantics

If the transaction that would record a result fails (for example the database is locked past
`busyTimeoutMs`), the runtime does not report `completed`. The local `wait()` rejects with
`PERSISTENCE_FAILED` (cause attached). The owner then retries a conditional transaction on its
heartbeat loop: state `interrupted`, `errorCode: PERSISTENCE_FAILED`, workspace released,
event `interrupted` with `reason: persistence_failed`. If a process tree could not be verified
dead, the run is interrupted with retained ownership instead of releasing the workspace.

## Environment curation and output

- The fixture is spawned with `shell: false`, `windowsHide: true`, `detached: true` and an explicit minimal
  environment: `ORGANIS_FIXTURE=1`, on Windows `SystemRoot`, and `ELECTRON_RUN_AS_NODE=1` when
  running inside Electron. `process.env` is never spread; credential-bearing keys such as
  provider tokens are excluded. This is environment curation, not a security sandbox.
- The fixture checks its own environment names against an allowlist and reports `ENV_LEAK`
  (exit 4) if any other name is present. It reports names only.
- Windows note: libuv re-adds a fixed set of non-credential variables from the parent when a
  spawn environment omits them (`HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`,
  `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR`). M1 omits these values and libuv
  restores them, so the allowlist includes these names on `win32` only. Values under these
  standard names can still originate from the parent; no values are logged.
- stdio is `ignore`; the only channel is a private IPC pipe carrying `ready` and `result`
  messages. The runtime accepts only those two shapes, ignores everything else and stores no
  arbitrary output.

## Cancellation

- `cancel()` records `cancelling` and returns that snapshot. It never returns `cancelled` on
  request alone. A queued run that has not been spawned is cancelled by its owner without
  starting a process.
- The owner sends a cooperative IPC `cancel`, waits up to 1.5 s for the child exit **and** the
  reported grandchild pid to be gone, then kills its still-live child through the current
  `ChildProcess` handle and waits up to 5 s. The fixed fixture owns its grandchild's handle;
  IPC disconnect also stops that grandchild. A run becomes `cancelled` only after identities
  have been received and both exits are verified, including cancellation during startup.
- If death cannot be verified, the run stays `cancelling` with `errorCode: CANCEL_UNVERIFIED`
  and a `cancel_unverified` event, and the owner retries at least 2 s later.
- No platform invokes `taskkill` or signals recorded pids or process groups. If cooperative
  cleanup and live process handles cannot establish termination, the workspace stays busy.
- `close()` requests cancellation of the instance's own live runs (bounded at about 8 s),
  marks its owner row closed and closes the database. It never touches other owners' runs.

## Electron node mode and packaging

Inside Electron the runtime spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, which
runs the fixture as plain Node. This requires Electron's `RunAsNode` fuse to remain enabled.
The packaging config copies the runtime and fixture together to `resources/runtime`, outside
`app.asar`; the fixture path is derived from its module URL. Packaged desktop smoke checks
execute this exact layout.

## Multi-client and mobile model

- A phone or second desktop is a **client of the same authoritative owner**; it never starts a
  duplicate agent session or a second coordinator.
- Acknowledgement and deduplication: the client generates `commandId` (a UUID) as an
  idempotency key. Replaying the same command returns the original run with
  `duplicate: true`, which doubles as the acknowledgement; no new process is started. The same
  `commandId` with a different payload fails with `COMMAND_CONFLICT`. Cancel commands use the
  same table (kind `cancel`, bound to the run id).
- Reconciliation: clients resume from the global event sequence (`events(id, after)`) and read
  the authoritative run snapshot. Receiving an event is not proof of completion; the run
  state is.

## Error classification

`retryable` means a client may submit a **new** command. The runtime never replays a command
or its side effects automatically.

| Code | Retryable |
| --- | --- |
| `INVALID_ARGUMENT`, `INVALID_WORKSPACE`, `SCOPE_DENIED`, `SANDBOX_UNSUPPORTED` | no |
| `COMMAND_CONFLICT`, `INVALID_TRANSITION`, `RUN_NOT_FOUND`, `SCHEMA_TOO_NEW` | no |
| `ENV_LEAK`, `CANCEL_UNVERIFIED`, `TERMINATION_UNVERIFIED` | no |
| `WORKSPACE_BUSY`, `PERSISTENCE_FAILED`, `RUNTIME_CLOSED`, `WAIT_TIMEOUT` | yes |
| `SPAWN_FAILED`, `FIXTURE_FAILED`, `OWNER_LOST` | yes |

## Entity concepts

| Entity | M1 status | Notes |
| --- | --- | --- |
| room | contract-only | Only an optional `roomId` label is stored on runs. |
| participant | contract-only | Room-local role with a provider session reference; only a `participantId` label is stored. |
| message | contract-only | Separate from execution events. See below. |
| workspace | implemented (fixture) | Canonical directory, single live writer. |
| task | implemented (fixture) | One per accepted command. |
| run | implemented (fixture) | Fixture launches only. |
| attempt | implemented (fixture) | Exactly one per run; never retried. |
| event | implemented (fixture) | Global sequence cursor. |
| agentCapability | implemented (fixture) | Only `organis.fixture`. A registered agent is a connection capability; a participant is not. |
| host | contract-only | Execution host registration not implemented. |
| artifact | contract-only | Outputs are not captured. |
| approval | contract-only | See below. |

Organis owns execution records, assignment and cancellation propagation. The provider will own
its native session semantics; neither chat text nor a session handle alone proves a task
finished.

### Room and message contract (future)

A message has `messageId`, `roomId`, `participantId`, a **per-room** `sequence`, and a
`commandId` for client deduplication. Messages are never mixed into the execution event stream;
clients keep one cursor per room for messages and one global cursor for execution events.
Desktop and mobile are both clients of the same room owner.

### Approval identity contract (future, not enforced)

Fields: `approvalId`, `runId`, `attemptId`, `scope` (the exact scope requested, never
broadened), `actionDigest`, `actionRevision`, `expiresAt`, `grantId`, `principalId`,
`requestedBy` (participantId), `decidedBy` (participantId, must differ from
`requestedBy`), `commandId`, `decidedAt`. M1 limitations: no approval is ever created or
decided; participant ids are client-supplied labels, not authenticated identities; the
`awaiting_approval` state is never entered.

## Tested platforms and limitations

- `.github/workflows/verify.yml` runs tests and packaged desktop/standalone CLI smoke checks
  on Windows x64, macOS arm64 and Linux x64. The PR records results for its current commit.
  Verification packages are unsigned directory builds, not installer or release-signing checks.
- Fixture-only: no real agent, provider, or model is launched.
- No sandbox or isolation of any kind; the fixture runs with the user's privileges in the
  chosen directory.
- Liveness uses pids without a start-time check, so pid reuse is possible after a crash.
- Single-host assumption: owner liveness is checked on the local machine only; `hostname` is
  recorded but a state directory shared across machines is unsupported.
- Event and run history is never pruned.
- `reconcile()` runs on construction and on request. Once an instance has started a run,
  its owner timer also rechecks retained leases every two seconds while the process is alive.
  Idle reader-only clients have no background coordinator.
