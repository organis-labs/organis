# R10 predecessor capability inventory

R10 reviewed committed snapshots from two private predecessors: an operations
application and an automation/configuration repository. The inventory covers
behavior relevant to local approvals, cancellation, recovery and collaboration.
Exact source revisions and file references are recorded in the private inventory.
Redistribution rights and component ownership remain unverified for every row.

| Capability | Source evidence and dependencies | Current test coverage | Organis disposition and open question |
| --- | --- | --- | --- |
| Approval bound to a specific artifact | Inspection of operations application source and tests found an artifact digest and review-state check. It depends on Swift, local files and an operations-specific approval model. Artifact content and request metadata are private. | [Organis collaboration tests](../../tests/collaboration.test.mjs) cover approval, refusal, expiry and changed revisions. | Keep [one-file approval](../specs/local-collaboration.md). Use exact artifact verification as a test criterion if approval scope grows. Portability remains unverified. |
| One-time execution claim across a crash | The automation/configuration repository uses a Python standard-library SQLite journal. It persists a consumed claim, distinguishes a duplicate from a payload conflict and blocks a second consumer. Operational authority and live state are private. | The isolated predecessor journal suite passed 11 tests on Windows. Organis [runtime](../../tests/runtime.test.mjs) and [recovery tests](../../tests/runtime-recovery.test.mjs) cover duplicate commands, concurrent ownership and uncertain launch recovery. | R11 candidate. The combined crash-and-retry case below needs fresh-setup acceptance under the [local runtime contract](../local-execution.md). |
| Cancellation and confirmed teardown | Inspection of operations application source and tests found that caller cancellation is separate from completion and late or mismatched confirmations are rejected. The implementation depends on host-specific authority and teardown state. Host identity and service state are private. | [Organis recovery tests](../../tests/runtime-recovery.test.mjs) cover late process identity, unverified descendants and uncertain launch recovery. | Keep local ownership and confirmed termination under the runtime contract. Remote teardown remains unverified and is deferred to M7. |
| Workflow readiness and attempt identity | Inspection of automation/configuration source found state transitions, dependency readiness and attempt identity. The coordinator is coupled to a service and its persisted workflow state. Private task records and instructions are excluded. | [Organis collaboration tests](../../tests/collaboration.test.mjs) cover a bounded revision, cancellation and interrupted review. | Keep the bounded serial [R09 flow](../specs/local-collaboration.md). Service-level parity remains unverified. Revisit dependency graphs when Organis needs a general workflow engine. |
| Skill intake and review | Inspection found a scanner wrapper with an external dependency and local policy settings in the automation/configuration repository. The operations application checks review state before accepting an artifact. Skill bodies and personal configuration are private. | Source inspection only. | Defer portable profiles and packs. A portable format, third-party redistribution review and fresh-setup tests are still needed. |

## R11 candidate and acceptance

Start with one behavior: an owner that exits after recording launch intent and
before recording a process identity must never cause a second launch when a
fresh client resubmits the same request. Use a synthetic workspace, command ID
and process fixture. Verify that the identical retry creates no new run or
process, a changed payload with the same ID reports a conflict, and a different
command cannot take over while ownership is still uncertain. Compare duplicate
and conflict handling with the predecessor using separate local state. If Organis
already meets the combined case, capture it as regression evidence.

R11 still requires review of provenance, ownership and redistribution terms
before any source reuse, plus a fresh-setup run using synthetic data. This
inventory used source inspection and existing synthetic tests. On Windows,
`npm test` passed the Organis type check and 158 tests. The journal suite was
the only predecessor suite run. Production parity and live-account behavior
remain unverified. Migration and cutover are outside R10.
