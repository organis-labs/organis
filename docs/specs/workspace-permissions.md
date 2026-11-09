# Workspace permissions and approval modes

Status: R04 design contract, 2026-11-10. The current product implements Codex
connection checks and fixture execution only. This document does not enable real
agent execution, migrate storage, or claim sandbox enforcement on any OS.

## User-facing contract

Desktop and CLI must manage the same host-local project registry and permission
records. A user selects a project, registers additional files or directories,
chooses their access, sees the effective sandbox, and selects one of four approval
modes. Follow the installed Codex backend's supported policies on the execution
host. Do not implement a weaker substitute under the same label.

Keep three decisions separate:

1. **Context:** which project or registered file is referenced in a task.
2. **Access:** which paths can be read or changed, and whether command network
   access is allowed. The OS-backed sandbox enforces these limits.
3. **Approval:** who may authorize a concrete action or additional access.

Adding context does not grant write permission. An approval does not turn off the
sandbox unless the user explicitly authorizes that exact change. Display requested
and effective permissions separately; a saved preference is not enforcement proof.

## Projects, folders and files

- Select an existing working directory through the desktop picker or an explicit
  CLI argument. Use the execution host's native absolute paths and filesystem
  identity. Do not hard-code a shared Windows/macOS/Linux checkout location or
  silently move a user's project into an Organis directory.
- Register additional files or directories with `read`, `write` (includes read),
  or `deny` access. Default newly registered context files to read access. Present
  the path, file/directory kind, effective access and the grant's lifetime before
  saving. A single-file grant must never become a parent-directory grant.
  If an active `deny` entry cannot be enforced, mark it unsupported and block
  sandboxed runs; never retain a decorative deny rule in an effective-policy view.
- Persist registry/settings locally outside the repository using the versioned
  runtime store. Store paths and grant metadata, not copied credentials or file
  contents. Do not publish or synchronize local paths as project defaults.
- Treat project registration and granting access as explicit user operations.
  Repository instructions, plans, model output, tool output, and imported settings
  cannot register paths or authorize themselves. Inherited provider configuration
  and managed requirements still need to be accounted for before a run.
- Resolve canonical paths and filesystem identity on the execution host. Test
  symlinks, Windows junctions, case behavior and aliases using that filesystem;
  do not infer equivalence from string prefixes or lowercase every macOS path.
  Revalidate at launch and before consuming an approval. A changed target requires
  fresh evaluation; path checks alone are not protection against concurrent swaps.
- An unregistered path is not automatically inaccessible: native Codex policies
  may include broader read access and runtime/system paths. Show those inherited
  allowances. Only advertise "registered paths only" when the backend enforces
  that restriction, including aliases and links; otherwise block that selection.
- Removing a registration removes future context selection and its Organis grant.
  Removing a grant does not erase other overlapping grants or inherited access.
  Show any remaining effective access. Changes during execution use the revocation
  rules below; do not claim that already-read data was erased from agent context.

The settings view has a project selector, registered-path list, per-path access,
sandbox status, command network access, approval mode and an effective-permissions
preview. Desktop uses native pickers; CLI supplies equivalent explicit paths and
structured output. CLI use requires neither Electron nor a display.

## Sandbox policy by execution environment

Expose `read-only`, `workspace-write` and explicit `full-access` presets, together
with supported custom path restrictions. Network access is shown independently.
Initial project defaults are sandboxed workspace write, command network disabled
and manual approvals. Show protected metadata paths and backend exceptions rather
than promising every file under a writable root can be changed.

| Environment | Policy source and required verification |
| --- | --- |
| Native Windows | Use Codex's selected Windows sandbox implementation and readiness checks. Display the actual backend and restrictions. Missing setup blocks sandboxed execution; it never selects full access. |
| macOS | Use the native Codex sandbox and respect macOS privacy/filesystem permissions. Verify protected folders and additional-file access on the actual machine. |
| Native Linux | Use the supported Codex Linux sandbox for that installed version. Verify required kernel/container capabilities and enforced path/network boundaries. |
| WSL2 | Treat the distribution as a separate Linux execution environment, with Linux paths and its own grants. Test mounted Windows paths separately; do not reuse native Windows permissions or describe WSL evidence as native Linux evidence. |

Codex currently documents Seatbelt on macOS, bubblewrap/seccomp on Linux, and
multiple native Windows backends. Backend availability is version and host
dependent. These are upstream mechanisms, not Organis platform acceptance results.
See [Codex sandbox security](https://learn.chatgpt.com/docs/agent-approvals-security)
and [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox).

Inspect managed constraints and effective configuration before execution. Keep
user and organization policies intact; use supported run/session configuration
instead of rewriting global Codex settings. Unknown, conflicting, unavailable or
unverifiable enforcement blocks the affected mode with a concrete reason.

Before enabling a mode, maintain a versioned compatibility table mapping the
Organis mode, Codex policy/reviewer/profile settings, OS backend, inherited rules
and observed behavior. The preview shows the resulting writable/readable roots,
not just the registered-file list. A legacy workspace-write root must remain
visible even when the user registered only one additional writable file.

## Four approval modes

The mode is selected for a run; a project may remember one of the first three
modes as its preference. Full access is never remembered or preselected. Increasing
authority during a run requires an explicit user choice and a new permission
snapshot. An agent cannot switch its own mode.
For R04, any mode change or authority increase stops the existing execution and
creates a newly verified session. Do not apply broader per-turn overrides to an
existing session. Revocations follow the stop-and-reconcile rules below.

| Mode | User experience | Authorization rule |
| --- | --- | --- |
| `manual` — individual approval | Show each approval request with the action, target, impact and allow-once/deny controls. | A person decides each request. No automatic approval, session-wide acceptance or persistent rule amendment. |
| `plan` — approve a plan first | Prepare a plan without side effects, let the user select concrete actions to preapprove, then execute. | Requires complete interception of side-effecting execution. Only unchanged, bounded, unexpired grants can satisfy matching requests. Unlisted or changed actions require another approval. |
| `auto-safe` — automatic except risky actions | Automatically authorize eligible low-risk requests; show risky or uncertain requests to the user. | Keep the sandbox. Risky/unknown actions require individual approval; a reviewer failure never implies permission. |
| `full-access` — full access | Explicitly acknowledge unrestricted local file/network access for this run. | Disable the optional Codex sandbox and action prompts only when the backend and managed policy allow it. OS permissions and mandatory policy still apply. |

Manual means individual **approval requests**, not a promise that every read or
every sandbox-allowed command produces a prompt. If a user requests interception
of every command/edit, expose that as an unsupported capability until it is proven;
never silently present native `on-request` behavior as that stricter guarantee.
The common risk gate below still applies: a risky in-sandbox action must not run
unreviewed in manual mode. If that gate is unavailable, manual execution is blocked.
Codex's current [permission modes](https://learn.chatgpt.com/docs/permission-modes)
also distinguish sandbox boundaries from the reviewer of eligible requests.

Full access is never a startup default, an error recovery step or an automatic
fallback for the other three modes. Do not persist its confirmation across runs.
Its preview must state that registered paths are context references, not access
boundaries, while the sandbox is disabled. Switching back requires a fresh
sandboxed session after the previous execution has stopped.
List each project `deny` entry that full access would disable and require explicit
acknowledgement of that list. Mandatory denies cannot be disabled; block full
access when managed policy requires them.
Escalating to full access also requires stopping the existing execution and
starting a new session; it cannot widen the live session in place.

### Plan preparation and preapproval

Planning runs read-only with side-effecting tools, external integrations and
command network access disabled. Reading approved context and provider inference
remain possible. Codex plan mode or prose such as "the user approved this plan"
is not a permission grant.

A plan records its revision and digest, project/host identity, intended file
operations, commands with working directories, requested network access and
expected artifacts. Show each proposed authorization separately so the user can
approve a subset. Unresolved commands, scripts with unknown effects, wildcards,
free-form descriptions and broad "do anything necessary" steps cannot create
executable preapproval grants.

The planning phase produces a proposal, not a grant. Finish that read-only session,
initialize and verify an execution session with the proposed permission snapshot
without starting a turn, then show the plan and effective execution scope for user
approval. Only after that approval may grants be issued for that execution session
and its first turn begin. If effective scope differs from the preview, stop and
obtain a fresh decision. No grant is transferred from the planning session, and
subsequent session/snapshot changes still invalidate execution grants.

Bind each grant to the run, attempt, participant, provider session, permission
snapshot, plan revision and exact action digest. The digest includes the tool,
arguments, execution directory, resolved targets, operation and proposed patch
where available. For a script or executable whose contents can change, bind and
revalidate the relevant content identity as well. Treat indirect or unverifiable
effects as needing individual approval; textual command equality is insufficient.

Default to a single use within the current attempt, with a visible expiry. Plan
or permission changes invalidate unconsumed grants. A retry, resumed session,
different host, changed file target or changed action cannot reuse them. Reject
duplicate consumption atomically. Never translate a bounded grant into
`acceptForSession`, a persistent command rule or a global network allowance.
Provider permission requests with turn/session lifetime are not single-action
grants. In manual and plan modes, deny such requests unless a verified per-action
mechanism can express the approved scope. A user can separately change project
access through the trusted settings flow, with its broader lifetime made explicit;
that creates a new snapshot/session and invalidates old action approvals.

Enable plan mode only when **every** operation capable of side effects or expanded
authority is intercepted and bound before it takes effect, including commands and
edits already allowed inside the sandbox. Otherwise the entire plan mode is
unavailable. Disable non-interceptable execution surfaces for this mode. A sandbox
allowing a file write does not enforce the approved patch, so narrower writable
roots alone cannot establish exact-action preapproval. Never rely on prompting
the model to stay within the plan.

### Automatic review and risky actions

Use a supported native reviewer where its verified behavior matches this mode.
Do not substitute a command-name allowlist or grant full access to avoid prompts.
The shared risk gate for manual, plan and auto-safe modes includes destructive operations, credentials,
permission/security changes, external publication/deployment, production data,
new access outside the approved effective scope, and actions whose effect cannot be established.
These require user review even when a model considers them safe. Plan preapproval
does not bypass this gate; risky steps receive individual review when executable.

Native `auto_review` handles eligible approval requests, not every local action.
Before enabling any of these three modes, prove the hard gate covers relevant actions that the
backend could otherwise execute inside its sandbox or via existing allow rules.
An allow decision is usable only for the unchanged requested scope. A policy
denial is final; review errors, indeterminate results and user-review requests
remain paused. Human review may proceed only through a supported, policy-permitted
path. Never retry a denied action under weaker settings.

If a pinned version uses `strictAutoReview` to request review of later commands,
set and record it explicitly rather than relying on its nullable default. Test its
actual coverage, including non-command edits and inherited rules. The field's
presence is not proof of the hard gate; incomplete coverage disables this mode.

## Codex adapter compatibility

Evidence checked on 2026-11-10: generated local Codex 0.164.0 stable/experimental
app-server schemas and current official documentation. Schema fields demonstrate
an interface, not enforcement or compatibility on every host.

| Interface | R04 use and gate |
| --- | --- |
| `thread/start`, `turn/start` | Bind the explicit workspace, approval policy/reviewer and effective sandbox to the run; verify available effective settings before a turn can act. Resume requires the same checks. |
| Command/file approval requests | Correlate provider thread, turn and item with the Organis attempt; render the exact action or patch, then return a one-time decision. Incomplete action evidence cannot be autoapproved. |
| `item/permissions/requestApproval` | Grant only a user-authorized subset. Manual/plan single-action rules above take precedence over the provider's default turn scope. Auto-safe may use turn scope only within its verified risk gate and visible snapshot; no implicit session grants. |
| `permissionProfile/list`, `configRequirements/read` | Discover available profiles and managed constraints for the selected project. Do not log private configuration values or treat allowed profiles as already selected. |
| Experimental `thread/start.permissions` | Named-profile selection exists in the pinned experimental schema, not its stable thread-start fields. Version-gate and test it explicitly before using it. |

Every outgoing turn must use the verified immutable permission snapshot. Reject
overrides of cwd, sandbox, approval policy or reviewer that diverge from it.
Omitting fields is allowed only where inheritance has been verified for the pinned
version; never let provider defaults silently expand the snapshot. For profiles,
do not add a legacy `sandboxPolicy` merely to repeat settings. The stable 0.164.0
thread-start response does not echo a profile id: it cannot alone verify selection.
Require backend-specific effective-policy evidence and native canary probes before
enabling profile-dependent access. Disable it when effective settings are unknown.

The pinned file-approval request describes `grantRoot` as unstable and possibly
unhonored. Do not rely on it to enforce a file boundary or accept a request that
would widen it to a root. Unknown request variants stop execution for evaluation.

The current stable checker remains unchanged. R04 must choose and verify an
execution protocol version; connection support for 0.164.0 is not execution
approval. Current upstream documentation retires explicit `untrusted` approval
configuration even though the pinned 0.164.0 schema still exposes it. Do not copy
that old enum into a version-independent mode mapping. See
[approval policy migration](https://learn.chatgpt.com/docs/agent-approvals-security).

Codex profiles and legacy sandbox configuration must not be mixed. Detect legacy
configuration precedence and managed constraints; do not claim a profile applies
because it was merely submitted. Exact file grants/read restrictions require the
verified profile/permission mechanism. A legacy writable-root setting cannot
silently substitute a directory for a file. Domain allowlists require an active
enforcing proxy; network enabled alone is insufficient. See
[permission profiles](https://learn.chatgpt.com/docs/permissions) and
[app-server permissions](https://learn.chatgpt.com/docs/app-server).

## Decision ownership, cancellation and revocation

Extend the existing [approval identity contract](../local-execution.md#approval-identity-contract-future-not-enforced)
with the policy snapshot and grant bindings above. One owning runtime authorizes
each decision. Desktop and CLI read the same pending record and submit a unique
command identity; first valid decision wins. Chat text is never the decision API.

Use a unique Organis approval id and correlate the provider connection epoch,
JSON-RPC request id, thread, turn, item and optional provider `approvalId`. Multiple
subcommand/stdin approvals can share an item; do not deduplicate by item alone.
Bind the environment to the verified local host/session. Non-local or non-null
provider environment ids are unsupported until their semantics are separately
verified; a missing id cannot silently select another environment.

Approval authority belongs to a trusted interactive client, not an agent label or
an accessible `approve` command. Isolate and authenticate the decision channel;
agent subprocesses must not inherit its credentials or be able to invoke it as the
user. A CLI approval surface must meet the same requirement as desktop IPC. This
is an implementation gate, including attempts to self-approve from agent tools.

An approval wait preserves the workspace lease and owner heartbeat. Denial,
expiry, cancellation, owner loss and invalidated scope cannot become approval.
Record requested/approved/denied/expired/revoked/consumed decisions and their actor,
scope and timestamps, without credential values. Commit authorization durably
before sending a provider response. If response delivery is uncertain, reconcile
without replaying the action or inventing completion.

Revocation prevents new actions immediately at the coordinator. If already-issued
provider permissions cannot be revoked in place, stop the owning execution and
recreate a restricted session. Display "revocation pending" until termination is
confirmed. A thread/turn completion notification alone does not establish that
tool descendants have stopped. Retain M1's lease on uncertain termination.

Unknown server requests are denied or stop the run, never accepted by default.
Hooks, MCP, plugins, browser/computer control and provider-native delegation require
separate capability/grant handling; keep them disabled for the initial execution
slice. A filesystem sandbox is not authority for those external surfaces.

## Implementation order and acceptance

This specification completes the policy-definition portion of R04, not R04/M2
execution acceptance. Implement in this order:

1. Versioned host/project/path registry, effective-policy resolution and capability
   reporting, shared by CLI and desktop. Disabled controls explain the exact gap.
2. Codex execution ownership, durable approval/decision APIs and the common risk
   gate, then manual and explicit full-access modes with verified sandbox behavior.
3. Read-only planning and bounded grant consumption, then automatic review with
   the same risk gate. Keep either mode unavailable until its own tests pass.
4. Actual Windows, macOS and Linux CLI/desktop validation of the same implementation.
   Record WSL and native Linux separately. Release only the verified capabilities.

For each advertised environment and mode, record CLI version, backend, source
revision, requested/effective settings and these actual outcomes using synthetic
projects and canary files:

| Acceptance area | Required positive and negative evidence |
| --- | --- |
| Project/file access | Registered file reads; permitted edits; rejected sibling/parent access when restricted; denied files; overlapping grants; symlink/junction/case and target-swap attempts. |
| Sandbox/network | In-scope operation succeeds; prohibited out-of-scope write and network fail; missing backend blocks; managed disallow remains enforced; full access is visibly unsandboxed. |
| Manual decisions | Allow once, deny, expiry, subapprovals sharing an item, duplicate/conflicting clients, self-approval attempts, lost delivery and cancellation while waiting; risky in-sandbox commands/edits pause; accurately report which actions bypass native approval prompts. |
| Plan grants | Read-only preparation; no execution turn before approval of the verified execution session; approved subset executes once; unlisted in-sandbox command/write is blocked or paused; edited plan, changed script/patch/cwd/target, expired grant and replay never execute with the old authorization. |
| Automatic review | Low-risk allowed request; risky/unknown action pauses; reviewer error stays blocked; policy denial is not bypassed; inherited rules cannot evade the hard gate. |
| Revocation/recovery | Remove a live grant; block new work; stop/reconcile provider descendants; keep uncertain leases; reject stale decisions after restart, mode change or a new attempt. |
| Client parity | CLI works without Electron/display; desktop and CLI agree on grants, effective policy, pending requests, decisions and cancellation results. |

Until these pass, report the specific capability as unverified/unavailable. Unit
tests, schema generation and a successful connection check are not substitutes for
native permission-enforcement evidence.
