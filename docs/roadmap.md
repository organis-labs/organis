# Organis product roadmap

Updated: 2026-11-09. Status: reviewable planning draft. Future milestones below
are proposed sequencing, not implemented features, release promises, or approval
to make security, licensing, hosting, or data-retention decisions.

## Goal and first useful product

Organis will let a user connect a supported agent tool or model provider, select
a workspace and execution host, run a bounded task, inspect its progress, approve
scoped actions, and stop it reliably. Local CLI use must work without an Organis
account, relay, desktop application, or maintainer-operated inference service.
Remote execution, synchronization, and mobile management are optional extensions.

Start with an individual developer managing their own trusted workspaces and
machines. The first useful release is one complete local task flow with a real
agent adapter, a headless CLI, and a desktop client showing the same execution
state. Team administration, a marketplace, and a hosted service are not prerequisites.
The initial maintainer can deliver this alone; contribution infrastructure grows
when actual contributors need it, not when a star-count threshold is reached.

## Evidence and present state

Baseline reviewed: product `main` at
`552e028158a13a39b8e552efc75cab450f17f351`, published as
[v0.1.0-beta.1](https://github.com/organis-labs/organis/releases/tag/v0.1.0-beta.1).
Sources: repository guidance, [README](../README.md), package scripts, runtime/CLI
source and recorded release acceptance from November 6–7. This document does not
claim a new test run or an audit of every possible deployment scenario.

| Area | Current state |
| --- | --- |
| Desktop / CLI | Bootstrap window and CLI version/status; CLI independent of Electron |
| Distribution | Native Windows x64, macOS arm64, Linux x64 packages; public release assets and beta feeds |
| Desktop update | Real replacement/relaunch tested from local beta0 fixtures to public beta1 on Windows, macOS and WSL2 Linux |
| Update limits | Fixture was not a historical public release; Windows requires NSIS interaction; Mac used the button's IPC bridge; bare-metal Linux not verified |
| CLI update | Implemented verified staging and atomic version selection; unit/recovery coverage and scoped Mac simulated-old-version test, not full historical upgrades on every OS |
| Runtime | Metadata scaffold only; no task engine, agent execution, approvals or provider integration |
| Remote / sync / mobile | Not implemented |
| License | Not selected; public source is not an open-source license grant |

Private runner identities, signing setup, credentials and operational evidence
stay outside this public roadmap. Maintainers use the private infrastructure
operations guide for actual release commands and host configuration.

## Boundaries already established

- Separate agent-tool adapters (existing CLIs) from model-provider adapters used
  by an Organis-owned agent loop. An API connection is not a complete agent.
- Keep agent selection, model selection and execution host separate. Report
  capabilities explicitly; do not imply a CLI subscription grants API access.
- Runtime owns execution semantics independently of Electron and network services.
  Each run has one authoritative coordinator, with explicit ownership on recovery.
- Linux headless CLI execution must not require a display or an unlocked desktop.
- Preserve supported authentication flows. Never copy provider login caches into
  Organis storage or synchronize credential values as ordinary settings.
- Keep public reusable packages separate from private instructions, transcripts,
  personal configuration and machine-specific paths.
- Cancellation, interruption, failure and completion are distinct. Do not report
  resources as free until execution has actually stopped.

## Milestone order

Dates and version numbers are intentionally unassigned. A milestone closes only
when its acceptance evidence is linked. Status starts as `planned` unless shown.

| ID | Milestone | Dependencies | Exit outcome |
| --- | --- | --- | --- |
| M0 | Distribution foundation — implemented with scoped verification | None | Desktop and CLI can be installed and updated within documented coverage |
| M1 | Local execution contracts and persistence | M0 | One bounded local run has durable identity, state, events and safe cancellation |
| M2 | First supported agent-tool integration | M1 | A real agent completes a scoped task through CLI without maintainer configuration |
| M3 | Desktop onboarding and task management | M2 | A fresh user completes and observes that same flow in desktop |
| M4 | Persistent local host and recovery | M1–M3 | Runs survive client disconnects with one coordinator and reconciled state |
| M5 | Optional provider-backed agent loop | M1, M2 contracts | Organis can run a bounded tool loop through a user-selected model endpoint |
| M6 | Reusable skills and bounded workflows | M2; M4 for durable workflows | Versioned packages compose work without expanding permission silently |
| M7 | Remote execution and approvals | M4, authenticated protocol and threat model | Two authorized hosts execute and reconnect without duplicate side effects |
| M8 | Optional private synchronization | M4, approved privacy/recovery design | Selected private state synchronizes with conflicts and recovery handled |
| M9 | Mobile observation and approvals | M7; M8 only for synchronized state | A paired mobile client observes runs and approves exact pending actions |
| M10 | Broader beta and stable release readiness | Core flow plus selected scope | Documented compatibility, recovery and fresh-install acceptance hold |

M5 and M6 can proceed independently once their contracts exist. M8 is not required
for remote execution or mobile approval. M10 hardening begins with M1; stable
release scope need not include every optional milestone.

## M1 — Local execution contracts and persistence

Define workspace, task, run, attempt, agent capability, execution host, event,
artifact and approval concepts before exposing them through separate clients.
Choose a local storage approach in a short design decision; do not scatter
unversioned JSON formats across clients. Keep the initial implementation small.

Deliver lifecycle transitions, event ordering, durable identifiers, structured
CLI output, scoped process launch and process-tree cancellation. Draft states
include queued, running, awaiting approval, cancelling, cancelled, interrupted,
failed and completed; freeze exact states and transitions in the first spec.
Classify retryable failures without automatically replaying side effects.

Acceptance:
- A deterministic fixture starts and finishes through the headless CLI; persisted
  status and event history agree with the actual process result.
- Invalid workspace and denied scope fail before execution. Credential values are
  absent from logs and exported diagnostics.
- Cancel terminates owned children; a crash/restart marks uncertain work for
  reconciliation rather than inventing success or launching another copy.
- Concurrent requests cannot create two owners for one attempt. Persistence
  failures are visible and do not produce a false completed status.

## M2 — First supported agent-tool integration

Select the first adapter after a bounded feasibility check of supported interfaces
for Codex CLI and Claude CLI. Selection is still open; neither adapter is currently
implemented. Verify supported authentication, streaming, cancellation, approval,
resume and exit semantics against current upstream documentation at implementation
time. Do not assume identical capabilities or automate interactive terminal text
as a stable protocol when an official interface exists.

Deliver executable/version discovery, capability reporting, supported login handoff,
workspace selection, real progress events and normalized results. Add a second
adapter only after the first flow works; use it to validate the contract without
hiding provider-specific limitations.

Acceptance: on a fresh supported machine, a user can authenticate through the
tool's supported flow and run a bounded synthetic task. Missing executable,
unsupported version, expired authentication, denied approval, cancellation and
partial failure all produce actionable results. A tool with no enforceable scope
must disclose that limitation and cannot be advertised as sandboxed. Authentication
caches remain owned by the tool; no maintainer credentials are required.

## M3 — Desktop onboarding and task management

Build workspace selection, agent discovery/setup, a task composer, execution list,
detail/event view, output/artifact view and explicit cancellation. Display model
and host choices only where supported. Desktop consumes runtime contracts rather
than maintaining an independent task state machine.

Provide readable empty/loading/error states, keyboard navigation and accessible
status announcements. Show the exact action and scope for an approval, including
what denial does. Output or retrieved content must never become approval authority.

Acceptance: a fresh install completes the M2 flow without private configuration;
CLI and desktop agree about the same run. Closing/reopening the client has a
documented outcome. Repeated clicks do not start duplicate attempts; stale approval
views cannot authorize changed actions. The first-use flow includes recovery from
missing agents, authentication failure and unavailable workspace paths.

## M4 — Persistent local host and recovery

Introduce a daemon only when persistent execution is required. Define startup,
shutdown, upgrades, local-client authentication, ownership and protocol compatibility
before installing an OS service. Preserve standalone CLI use through the same
execution contract; do not let CLI and daemon independently coordinate a run.

Acceptance: reconnecting clients receive ordered history and current state without
rerunning work. Daemon restart reconciles live processes and unfinished attempts.
Incompatible client versions fail clearly. Service installation/uninstallation is
explicit and preserves user data. Test headless Linux, Windows and macOS separately;
an Electron desktop smoke does not establish daemon coverage.

## M5 — Optional provider-backed agent loop

Add a distinct model-provider interface for a selected hosted API and, later, a
compatible local/remote endpoint. Choose supported providers and API contracts in
a spec; no provider SDK, model list or price is fixed by this roadmap.

Implement the actual loop: streaming, tool dispatch, permission checks, cancellation,
context budgeting, bounded steps/resources, error classification and result
recording. Treat tool results and retrieved text as untrusted input. Credential
storage, network access and spend-limit policy require explicit design decisions.

Acceptance: an authorized tool executes once; an out-of-scope tool is denied;
approval is tied to immutable action parameters. Invalid tool arguments, network
failure, rate limits, exhausted budget and cancellation stop or recover without
unapproved side effects. Local endpoints work without a hosted-provider account.
Do not claim prompt instructions alone form a security boundary.

## M6 — Skills, packages and workflows

Keep execution and permission enforcement in product code. Independently versioned
skill packages consume a product-owned schema and validation contract. Start with
a small reviewed pack and explicit installation; defer a marketplace and automatic
discovery until provenance, trust and update behavior are defined.

Deliver pinned immutable versions, integrity/provenance metadata, compatibility
validation, private overrides and migration rules. Workflows need bounded steps,
attempt identities, cancellation propagation and explicit coordination ownership.
Parallel workers require non-overlapping scope or a defined conflict strategy.

Acceptance: incompatible or altered packages are rejected; an update cannot
silently widen permissions or overwrite private overrides. Cancelling a workflow
stops/reconciles its children. Retrying a completed step does not duplicate an
external write. Package examples contain synthetic data and redistributable content.

## M7 — Remote execution and approvals

Choose direct connection versus optional relay only after defining device identity,
pairing, authenticated transport, authorization, revocation and coordinator
ownership. A relay must not become mandatory for local use. Add host inventory and
capability checks; host paths and GPU/resource allocation stay host-local.

Acceptance: an authorized client submits to an explicit host; an unpaired or revoked
client cannot. Disconnection, repeated delivery, expired approval and competing
coordinators do not cause duplicate execution. An approval identifies requester,
action, target, parameters and validity; changed or replayed requests are rejected.
Never equate idle GPU memory with permission to use a shared device. Failure of a
relay leaves local execution usable and remote status honestly unknown when needed.

## M8 — Optional private synchronization

Before implementation, approve the data classes to sync, access control, encryption
and key ownership, recovery, retention, deletion and conflict semantics. Keep local
paths, running processes, caches and credential values out of portable settings.
Transcripts and private skills must not be uploaded merely because sync is enabled
for another data class. Authentication references do not transfer login sessions.

Acceptance: two devices reconcile revisions with explicit conflicts rather than
last-modified timestamps. Offline changes, deletion, revoked devices, lost keys,
partial upload and old schema versions have tested recovery behavior. Local-only
users remain supported. Do not ship cross-device private data until these policy
decisions and their tests are complete.

## M9 — Mobile observation and approvals

Choose mobile platforms and technology after M7's protocol is stable enough to
reuse. Start with paired-host status, task/event viewing and approval decisions;
phone-side agent execution is not part of the initial scope.

Acceptance: notifications are hints, not authority. Opening an approval retrieves
current authenticated state; stale, changed, expired and already-decided requests
cannot execute. Device revocation, offline handling, sensitive notification content
and accessibility are covered. Mobile and desktop display the same decision/result.

## M10 — Release readiness and ongoing quality

- Test the next genuine release as an upgrade from published beta1 for desktop
  and CLI on each supported OS; keep the earlier fixture-based evidence distinct.
- Extend Linux coverage to native headless and desktop installations. Add CPU
  architectures only with actual build and acceptance coverage.
- Decide Windows signing and distribution channels; do not describe current
  unsigned packages as signed. Preserve macOS signing/notarization validation.
- Version storage/protocol schemas and test interrupted migration, backup recovery,
  compatibility and safe rollback where supported. Do not promise app downgrade
  when the updater intentionally rejects it.
- Provide redacted diagnostics, actionable errors, crash recovery and user-controlled
  data export/deletion. Telemetry policy is undecided; no automatic transcript upload.
- Select a product license and verify attribution/provenance before soliciting
  reusable contributions. Add contribution/security reporting guidance and public
  checks that never expose secrets or run untrusted PR code on personal hosts.
- Establish measured startup, memory, event throughput and cancellation targets
  from realistic workloads; do not invent performance claims before measuring.

## Next work queue

These are work-item identifiers, not existing GitHub issue numbers. Recommended
order is local-contract spec, vertical CLI slice, first adapter, then desktop.

| ID | Deliverable | Completion evidence |
| --- | --- | --- |
| R01 | Specify lifecycle, ownership, event/error and persistence contracts | Reviewed state table and crash/cancel/retry cases; storage decision recorded |
| R02 | Implement local CLI execution with a deterministic fixture adapter | Headless completion, denial, cancellation and restart tests |
| R03 | Evaluate first real adapter's supported interface | Capability matrix and authenticated bounded-task evidence; selection decision |
| R04 | Implement the selected adapter | M2 acceptance, including failure/cancel paths |
| R05 | Specify and implement desktop first-task flow | Fresh-install task and matching runtime state |
| R06 | Close release coverage gaps for a genuine next release | Per-OS desktop/CLI old-to-new evidence; native Linux scope recorded |
| R07 | Decide licensing and publish contribution expectations | Maintainer-approved license and provenance checks |

R03 research and R07 can run alongside R01. Adapter implementation depends on
R01/R02 and its supported-interface evidence. No issues are created by this file.

## Decisions still needed

The maintainer is the decision point; no deadline is assumed. Record decisions in
short documents under `docs/decisions/` when made, linking the alternatives and
their effects. Do not implement an unresolved policy merely to finish a milestone.

| Decision | Needed before | Current disposition |
| --- | --- | --- |
| Product license and redistribution policy | External contribution/reuse expectations | Open; do not infer a license |
| First adapter and supported versions | R04 | Compare supported interfaces in R03 |
| Persistence, run ownership and local protocol | M1/M4 | Small local design first; daemon later |
| Permission enforcement and approval scope | Real side-effecting tools | Threat model and adapter capability limits required |
| Model providers, credential storage and budget policy | M5 | Separate from CLI authentication |
| Package trust/provenance and workflow coordination | M6 | Reviewed pinned packages first |
| Remote topology, identity and revocation | M7 | Optional remote service; no transport selected |
| Sync data, encryption, recovery and retention | M8 | Block private synchronization until approved |
| Mobile targets and client technology | M9 | Observation/approval first |
| Stable-release scope and support policy | M10 | Based on evidence, not completion of all optional features |

## How agents should use this roadmap

1. Read repository guidance and inspect current code; the baseline above can age.
2. Pick one bounded work item. For implementation, write its spec under
   `docs/specs/` with scope, non-goals, dependencies, state/data contracts, normal
   and failure flows, security assumptions and observable acceptance checks.
   Those directories are proposed destinations, not existing implementations.
3. Link an actual Issue/PR when created. Keep roadmap milestones as the overview
   and Issues as the execution tracker; never invent issue links or completion.
4. Resolve blocking decisions before implementing their dependent behavior.
   Keep operational secrets, private host details and transcripts out of public docs.
5. Mark progress as planned, in progress, blocked, implemented or verified. Link
   source revision and environment-specific evidence before using verified.
6. Update this document with changed scope and remaining limitations. Architecture
   decisions belong in `docs/decisions/`; a future `docs/architecture.md` should
   summarize the implemented boundaries without presenting planned packages as real.

This draft is ready for prioritization and R01 specification. It is not a blanket
implementation approval for every optional feature or unresolved security policy.
