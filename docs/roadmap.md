# Organis product roadmap

Updated: 2026-11-09. Status: M0 distribution baseline plus M1 fixture implementation;
later milestones remain a reviewable planning draft. Future milestones below
are proposed sequencing, not implemented features, release promises, or approval
to make security, licensing, hosting, or data-retention decisions.

## Goal and first useful product

Organis will let a user connect a supported agent tool or model provider, select
a workspace and execution host, run a bounded task, inspect its progress, approve
scoped actions, and stop it reliably. Local CLI use must work without an Organis
account, relay, desktop application, or maintainer-operated inference service.
Remote execution, synchronization, and mobile management are optional extensions.
Mobile is a full conversation-room client: users can request work and control
agents in the same rooms they use on desktop. Agents execute on the selected
authorized host, not on the phone. Local-only desktop/CLI use remains supported.

Start with an individual developer managing their own trusted workspaces and
machines. The target first useful product is a conversation room with explicitly
joined Claude and Codex participants: Claude plans, Organis assigns implementation
to Codex, and Claude reviews the recorded result. Prove the fixture and one-agent
paths before building this two-agent flow. A headless CLI and desktop client use
the same execution state. Team administration, a marketplace, and a hosted service
are not prerequisites.
The initial maintainer can deliver this alone; contribution infrastructure grows
when actual contributors need it, not when a star-count threshold is reached.

## Evidence and present state

Baseline reviewed: product `main` at
`552e028158a13a39b8e552efc75cab450f17f351`, published as
[v0.1.0-beta.1](https://github.com/organis-labs/organis/releases/tag/v0.1.0-beta.1).
Sources: repository guidance, [README](../README.md), package scripts, runtime/CLI
source and recorded release acceptance from November 6–7. This document does not
claim a new release or an audit of every possible deployment scenario. The M1
implementation in this change is described in the [local execution contract](local-execution.md).
Its [platform verification workflow](../.github/workflows/verify.yml) exercises
source tests and development packages on Windows x64, macOS arm64 and Linux x64;
the PR records actual per-platform results for the tested source revision.

| Area | Current state |
| --- | --- |
| Desktop / CLI | Shared local fixture execution, saved run/event inspection and cancellation; CLI independent of Electron |
| Distribution | Native Windows x64, macOS arm64, Linux x64 packages; public release assets and beta feeds |
| Desktop update | Real replacement/relaunch tested from local beta0 fixtures to public beta1 on Windows, macOS and WSL2 Linux |
| Update limits | Fixture was not a historical public release; Windows requires NSIS interaction; Mac used the button's IPC bridge; bare-metal Linux not verified |
| CLI update | Implemented verified staging and atomic version selection; unit/recovery coverage and scoped Mac simulated-old-version test, not full historical upgrades on every OS |
| Runtime | M1 fixture lifecycle, versioned SQLite persistence, command deduplication and recovery; no real agent, approval decisions or provider integration |
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

The room-participant direction comes from the maintainer's planning discussion.
A bounded Claude Fable review on 2026-11-09 recommended pulling minimal collaboration
ahead of general skill workflows and adding a parallel extraction track. This
revision adopts those sequencing changes. The review covered a supplied proposal,
not an audit of private source code or a provider-policy approval.

Dates and version numbers are intentionally unassigned. A milestone closes only
when its acceptance evidence is linked. Status starts as `planned` unless shown.

| ID | Milestone | Dependencies | Exit outcome |
| --- | --- | --- | --- |
| M0 | Distribution foundation — implemented with scoped verification | None | Desktop and CLI can be installed and updated within documented coverage |
| M1 | Local execution contracts and persistence — fixture implemented | M0 | One bounded local fixture run has durable identity, state, events and safe cancellation |
| M2 | First supported agent-tool integration | M1 | A real agent completes a scoped task through CLI without maintainer configuration |
| M2.5 | Room participants and bounded collaboration | M1, M2, routing/context spec | Claude plan -> Codex implementation -> Claude review, all tracked by Organis |
| M3 | Desktop onboarding and room management | M2.5 for full acceptance | A fresh user joins agents to a room and observes the same collaboration state |
| M4 | Persistent local host and recovery | M1–M3 | Runs survive client disconnects with one coordinator and reconciled state |
| M5 | Optional provider-backed agent loop | M1, M2 contracts | Organis can run a bounded tool loop through a user-selected model endpoint |
| M6 | Reusable skills and bounded workflows | M2; M4 for durable workflows | Versioned packages compose work without expanding permission silently |
| M7 | Remote execution and approvals | M4, authenticated protocol and threat model | Two authorized hosts execute and reconnect without duplicate side effects |
| M8 | Optional private synchronization | M4, approved privacy/recovery design | Selected private state synchronizes with conflicts and recovery handled |
| M9 | Mobile shared-room work and control | M7, room contracts; independent of M8 | A paired phone joins the same rooms, requests work, steers/cancels tasks and handles approvals |
| M10 | Broader beta and stable release readiness | Core flow plus selected scope | Documented compatibility, recovery and fresh-install acceptance hold |

M5 and M6 can proceed independently once their contracts exist. M8 is not required
for remote execution or mobile room control. M10 hardening begins with M1; stable
release scope need not include every optional milestone.
M3 UI prototyping can start earlier, but cannot substitute for M2.5 acceptance.
Mobile contracts start in M1 and mobile interaction design starts alongside M3.
M9 denotes end-to-end mobile acceptance after M7, not the start of all mobile work.
M2.5 requires neither a daemon nor a reusable workflow engine. The extraction track
below starts with inventory alongside M1; implementation waits for its review gates.

## M1 — Local execution contracts and persistence

Implementation: [contract and storage decision](local-execution.md),
[runtime acceptance tests](../tests/runtime.test.mjs),
[CLI acceptance tests](../tests/cli-execution.test.mjs), and native development
package verification via `npm run verify:platform`. Both desktop and CLI use the
same local state and fixed fixture. The desktop test exercises actual renderer
controls, cancellation and the runtime-unavailable recovery view. These checks
do not establish real-agent support, release signing or installer acceptance.
Room membership, messaging, approval execution and mobile transport remain later
implementation work; their identities and boundaries are specified now.

Define room, participant, workspace, task, run, attempt, agent capability, execution
host, event, artifact and approval concepts before exposing them through clients.
Separate room messages from execution events. A registered agent is a connection
capability; a participant is a room-local role with a provider session reference.
Organis owns execution records, assignment and cancellation propagation. The
provider owns its native session semantics; neither chat text nor a session handle
alone is proof that a task finished.
Design room/message/participant identities and event cursors for desktop and mobile
from the outset. Both are clients of the same authoritative room owner; the phone
does not create a duplicate agent session or independent coordinator. Define
command acknowledgement, deduplication and reconciliation for multiple clients.
Choose a local storage approach in a short design decision; do not scatter
unversioned JSON formats across clients. Keep the initial implementation small.

Deliver lifecycle transitions, event ordering, durable identifiers, structured
CLI output, scoped process launch and process-tree cancellation. Draft states
include queued, running, awaiting approval, cancelling, cancelled, interrupted,
failed and completed; freeze exact states and transitions in the first spec.
Classify retryable failures without automatically replaying side effects.
Specify write ownership, session/process ownership and approval scope before real
execution. No permission-bypass defaults and no worktree-as-sandbox claims. Reject
unsupported enforcement requirements instead of silently weakening the requested
scope. Start with serial writes per shared checkout; parallel conflicting writers
are out of the first slice.

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

Global connection setup discovers an installed executable, version, supported
features and authentication status through supported interfaces. Registration does
not join a room or start a task. Use the user's unmodified CLI and provider-owned
authentication; do not import credential caches into Organis. Confirm and document
the selected integration mode's current provider requirements before implementing
it as a distributed product feature.

Select the first adapter after a bounded feasibility check of supported interfaces
for Codex CLI and Claude CLI. This selects which of the two to implement first,
not a replacement for the target two-participant flow. Selection is still open; neither adapter is currently
implemented. Verify supported authentication, streaming, cancellation, approval,
resume and exit semantics against current upstream documentation at implementation
time. Do not assume identical capabilities or automate interactive terminal text
as a stable protocol when an official interface exists.

Deliver executable/version discovery, capability reporting, supported login handoff,
workspace selection, real progress events and normalized results. Add a second
adapter only after the first flow works; use it to validate the contract without
hiding provider-specific limitations.

Reference implementation, not a dependency or policy precedent: Orca at
`4fc4d792be0e1bf7c4ffba2a4da106cfaa523812` points its Claude SDK integration at
the installed user CLI and launches Codex through `app-server`. See
[Claude launch](https://github.com/stablyai/orca/blob/4fc4d792be0e1bf7c4ffba2a4da106cfaa523812/src/main/claude/structured/launch/claude-structured-launch-resolution.ts)
and [Codex launch](https://github.com/stablyai/orca/blob/4fc4d792be0e1bf7c4ffba2a4da106cfaa523812/src/main/codex/structured/launch/codex-structured-launch-resolution.ts).
These are feasibility candidates, not final adapter choices. Do not copy account
switching, credential handling or permission bypass behavior as part of this slice.

Acceptance: on a fresh supported machine, a user can authenticate through the
tool's supported flow and run a bounded synthetic task. Missing executable,
unsupported version, expired authentication, denied approval, cancellation and
partial failure all produce actionable results. A tool with no enforceable scope
must disclose that limitation and cannot be advertised as sandboxed. Authentication
caches remain owned by the tool; no maintainer credentials are required.

## M2.5 — Room participants and bounded collaboration

Connection setup and room membership are distinct. Users join connected agents to
a room and assign roles; there is no single app-wide agent that replaces the rest.
Agent, model, role, host and tool access remain separately represented. A team
profile may prefill a room's participants and roles after explicit user selection;
it does not grant permissions or start work by itself.

Proposed minimal rules, to freeze in the routing/context spec before implementation:
- One lead participant per room handles unaddressed user requests. `@participant`
  targets that participant. Missing/ambiguous targets fail visibly; there is no
  automatic fan-out to every registered agent.
- Other participants receive bounded assignment briefs and referenced artifacts,
  not the entire raw transcript by default. Direct-message content is not
  automatically forwarded to the lead. Define visible sharing controls before
  widening context; context is data, never authority to grant permissions.
- The lead proposes assignments through an Organis-controlled interface. Organis
  records requester, assignee, room, scope, attempt and artifact relationships.
  Untracked sibling-agent spawning is not the supported delegation mechanism.
  Provider-native subagents require an explicit capability/visibility policy.
- Start with one active task per participant and one writer per shared checkout.
  Lead changes apply between assignments. Participant removal during a task must
  explicitly cancel it or retain it until completion; it cannot orphan execution.
- Permission grants apply to scoped room/task actions, not global trust in an
  agent. Approval binds to the concrete action; changing the action invalidates it.
- Review produces a separate artifact and can request bounded revisions. A user-
  visible revision limit is required; the default and room/task override policy
  remain undecided. Exceeding it stops for user input rather than looping forever.
- An image generator is a tool/provider capability, not necessarily a CLI agent.
  Notion, Slack and Figma-style connectors are tools with separate grants. Their
  detailed implementation is later work, not a prerequisite for this code-only slice.

Acceptance: user request -> Claude plan artifact -> visible Organis assignment ->
Codex diff and actual test execution record -> Claude review artifact -> final
execution outcome. Review approval alone cannot mark the work verified. Record
test commands, exit status, outputs and the source revision tested; preserve failed,
cancelled, blocked and interrupted outcomes separately.

Exercise duplicate delivery, participant crash, refusal, expired approval, denied
scope and revision-limit exhaustion. Joining/registering another agent must not
start work or expose room history. Cancelling the parent reconciles owned child
work; verify actual termination before freeing resources. An adapter unable to
enforce a requested boundary must reject that configuration. Test the headless
path before claiming collaboration requires a GUI. Remote execution is deferred.

## M3 — Desktop onboarding and room management

Design the mobile version of the same room flows alongside desktop: participant
selection, mentions, attachments, progress, artifacts, approval and cancellation.
Share runtime contracts rather than requiring identical screen layouts. Prototype
phone loading, offline, reconnect and conflicting-control states before M7/M9.

Build global agent connection setup, room creation, participant/lead selection,
workspace selection, a task composer, execution list,
detail/event view, output/artifact view and explicit cancellation. Display model
and host choices only where supported. Desktop consumes runtime contracts rather
than maintaining an independent task state machine.

Provide readable empty/loading/error states, keyboard navigation and accessible
status announcements. Show the exact action and scope for an approval, including
what denial does. Output or retrieved content must never become approval authority.

Acceptance: a fresh install completes the M2.5 flow without private configuration;
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

Minimal room routing and plan/code/review already belong to M2.5. This milestone
generalizes proven behavior into reusable team profiles, skill packs and workflows;
do not make the first collaboration flow depend on a generic workflow framework.

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

Expose authenticated room access and task-control contracts for desktop and mobile
clients, not only machine-to-machine task submission. A paired client can list and
open authorized rooms, send messages, manage permitted participants, submit work,
receive events/artifacts and issue scoped control commands. Enforce authorization
on the owning host for every command. Reconcile concurrent desktop/phone commands;
stale approvals and duplicate submissions cannot create a second execution.

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

## M9 — Mobile shared-room work and control

The maintainer's requested scope is the same conversation rooms on desktop and
mobile, including initiating and controlling work. Choose supported mobile platforms
and client technology during the M3 design track; do not assume a framework or ship
date. Reuse M1/M2.5 room semantics and M7 authenticated transport. Claude/Codex and
their authentication remain on the selected execution host. Running coding CLIs on
the phone is outside the initial scope.

Deliver:
- Pair/revoke a device and select an authorized execution host; show unavailable
  hosts explicitly rather than silently choosing another machine.
- List, create and reopen authorized rooms. Join connected host agents, inspect
  and change roles within the same membership and active-task rules as desktop.
- Send ordinary requests and `@participant` messages; attach files/images through
  explicit upload to the selected host. Phone-local paths are not host file paths.
  Define upload permissions, limits, retention and failure handling before shipping.
- Show participant progress, messages, logs, changed-file summaries, images and
  result artifacts with source/run identity. Apply existing context-sharing rules.
- Send follow-up instructions; visibly distinguish queued input from steering an
  active task where supported. Cancel work and approve/deny exact pending actions.
- Notify about approval requests, completion and failures, with privacy-conscious
  previews. Notifications open current authenticated room state, not executable
  authorization payloads. Define platform background/push behavior explicitly.

Acceptance:
- Create a room on desktop, open it on a paired phone, request the Claude plan ->
  Codex implementation -> Claude review flow from the phone, and observe the same
  room, participant sessions, task IDs and results on both clients. Also create a
  room on mobile and continue it from desktop without duplicating execution.
- Mobile follow-up, scoped approval/denial and cancellation reach the owning host;
  both clients converge on the actual result. Revoked/unauthorized devices cannot
  read rooms or control work, even through old notifications.
- Disconnect after submitting: show acknowledged, unsent or uncertain delivery
  honestly; reconcile by command identity before retry. Repeated taps, reconnects
  and conflicting desktop/phone controls do not start duplicate attempts. Offline
  draft handling must not silently execute accumulated work after reconnection.
- Force-close/background the phone while a host task runs: host ownership remains
  intact, and reopening restores current state plus missing events. Do not require
  the mobile process to stay alive for the task to continue.
- Stale, changed, expired and already-decided approvals cannot execute. A cancel
  request is not displayed as cancelled until termination is confirmed.
- Interrupted attachment upload cannot produce a task referencing a missing file;
  artifact access respects room authorization. Test accessibility and supported
  phone/platform behavior separately before claiming platform coverage.

This requires live access to host-owned room state, not M8's general cross-device
private-state synchronization. Offline replicas, merging independent room stores
and phone-side agent execution are deferred unless separately specified.

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
order is integration/room contracts, fixture, one real participant, two-agent
collaboration, then full desktop acceptance. Preserve existing work-item IDs.

| ID | Deliverable | Completion evidence |
| --- | --- | --- |
| R01 | Specify room/participant and lifecycle, ownership, event/error and persistence contracts | Reviewed state table, write/session ownership and crash/cancel/retry cases; storage decision recorded |
| R02 | Implement local CLI execution with a deterministic fixture adapter | Headless completion, denial, cancellation and restart tests |
| R03 | Evaluate installed Claude/Codex interfaces and authentication mode | Capability/policy note, supported versions, bounded-task evidence; first-adapter decision |
| R04 | Implement the selected adapter | M2 acceptance, including failure/cancel paths |
| R05 | Specify and implement desktop room/participant flow | Fresh-install M2.5 collaboration and matching runtime state |
| R06 | Close release coverage gaps for a genuine next release | Per-OS desktop/CLI old-to-new evidence; native Linux scope recorded |
| R07 | Decide licensing and publish contribution expectations | Maintainer-approved license and provenance checks |
| R08 | Specify message routing, context sharing, approvals and revision bounds | Explicit target/lead/privacy rules and negative cases before room history is sent |
| R09 | Add second real participant and plan/code/review flow | M2.5 artifacts, actual test records, bounded revisions, failure/cancel acceptance |
| R10 | Inventory private predecessor capabilities | Sanitized extraction matrix with provenance and unknowns; no bulk import or cutover |
| R11 | Extract one reviewed reusable capability | Synthetic tests, fresh-machine acceptance and preserved original behavior |
| R12 | Specify shared desktop/mobile room interaction and control contracts | M1 identities plus mobile M3 flows, delivery/reconnect, attachment and permission decisions |
| R13 | Implement mobile shared-room client after M7 | M9 phone-originated work, steering, approval, cancellation and cross-client recovery evidence |

R03, R07, R08 and inventory-only R10 can run alongside R01. R04 depends on R01/R02
and R03; R08 must be resolved before forwarding room context to a real participant.
R09 follows R04/R08 and proves the second adapter; R05 full acceptance follows R09.
R11 follows the extraction gates below. No issues are created by this file.
R12 contract work runs with R01/R08, and mobile UX design with R05; it does not wait
for M9. R13 requires R09, M4/M7 and resolved mobile transport/platform/data policies,
but not M8 or M5/M6. Implementation may be staged; full acceptance is M9.

## Parallel extraction track — preserve the working predecessors

The maintainer's private operations and configuration projects are candidate
predecessors, not product dependencies. Their code was not audited for this revision. Do not claim that their
features are portable, licensed for redistribution or already migrated.

| Candidate area | Potential destination | Must remain private / unresolved |
| --- | --- | --- |
| Execution, approval and host-management behavior | Runtime contracts; later daemon/remote adapters | Host service configuration, device identities, authorization state |
| Role, instruction and skill configuration | User-selected room profiles and versioned packs | Personal instructions, private skills, account and machine-specific values |
| Operational lessons and failure cases | Synthetic regression cases and portable design notes | Transcripts, credentials, raw operational logs and third-party private content |

For each candidate, record capability, source revision, dependencies, ownership/
license, sensitive-data exposure, extract-versus-rewrite decision, destination and
acceptance evidence. Keep the detailed source inventory private; publish only a
sanitized design and reviewed code in clean product history.

Sequence: inventory -> provenance/license/private-data review -> minimal extraction
or rewrite -> synthetic tests -> side-by-side behavior comparison -> explicit cutover.
The original projects and services continue unchanged until separately authorized
cutover with a recovery path. Do not bulk-import repositories, synchronize personal
configuration by default, or copy secret stores. Side-by-side tests must not run
both systems against the same real side-effecting task. Use fixtures or separate
owned resources; preserve the original execution owner.

Prioritize only capabilities needed by R01–R09. Remote-host and synchronization
code can wait for M7/M8. Passing on the maintainer's machine is insufficient:
extracted functionality must work with synthetic configuration on a fresh setup.

## Decisions still needed

The maintainer is the decision point; no deadline is assumed. Record decisions in
short documents under `docs/decisions/` when made, linking the alternatives and
their effects. Do not implement an unresolved policy merely to finish a milestone.

| Decision | Needed before | Current disposition |
| --- | --- | --- |
| Product license and redistribution policy | External contribution/reuse expectations | Open; do not infer a license |
| First adapter and supported versions | R04 | Compare supported interfaces in R03 |
| Installed CLI integration mode and provider requirements | R04 | User-owned unmodified CLI is the candidate; verify exact mode, not Orca precedent |
| Lead handoff, mention routing and context visibility | R08 / M2.5 | One room lead and bounded briefs proposed; no implicit transcript broadcast |
| Revision limit, writer scope and participant removal | R08 design; R09 implementation | Bounded serial collaboration first; defaults and transitions need specification |
| Private capability extraction | R11 | Inventory and provenance gate; source reuse not yet established |
| Persistence, run ownership and local protocol | M1/M4 | Small local design first; daemon later |
| Permission enforcement and approval scope | Real side-effecting tools | Threat model and adapter capability limits required |
| Model providers, credential storage and budget policy | M5 | Separate from CLI authentication |
| Package trust/provenance and workflow coordination | M6 | Reviewed pinned packages first |
| Remote topology, identity and revocation | M7 | Optional remote service; no transport selected |
| Sync data, encryption, recovery and retention | M8 | Block private synchronization until approved |
| Mobile targets, technology and background/push behavior | M3 design; R13 implementation | Full shared-room work/control; host execution, platform choice open |
| Mobile attachment and offline delivery policy | R12; before R13 shipping | Explicit host upload, authorization/retention and deduplication required |
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
