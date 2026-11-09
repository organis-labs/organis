# First agent adapter: user-installed Codex app-server

Date: 2026-11-09. Scope: R03 feasibility and connection discovery.

The maintainer selected **Codex CLI first**. Use the user's unmodified installed
CLI through its supported stdio app-server protocol. Claude remains the planned
second adapter for M2.5; selecting Codex does not select a fixed model or host.

## Interface comparison

| Concern | Codex CLI | Claude Code CLI |
| --- | --- | --- |
| Installed version inspected | 0.164.0 | 2.1.316 |
| Structured interface | app-server, newline-delimited JSON-RPC | `-p`/headless Agent SDK interface, including stream-json |
| Authentication ownership | Codex-managed sign-in; inspect with `account/read` | Claude-managed supported user sign-in; `auth status --json` |
| Task events | turn/item notifications and message deltas | streaming structured messages and result |
| Task stop | `turn/interrupt`, then terminal notification; process cleanup is a separate condition | Requires separate adapter lifecycle/cleanup verification |
| Approval | Server requests require explicit client decisions | Supported tool/permission control requires separate product policy |
| Resume | `thread/resume` exists; not exposed by this slice | Native session resume exists; not evaluated for Organis replay safety |

OpenAI documents app-server as an interface for clients integrating Codex, including
initialization, managed authentication, threads, turns and interruption. This
choice uses that interface, not a copied login cache or an assumption that a CLI
subscription is a general API credential. See the [official app-server reference](https://learn.chatgpt.com/docs/app-server)
and [Codex platform introduction](https://developers.openai.com/blog/codex-as-a-platform).

Anthropic documents programmatic Claude Code usage and permits certain products
to run an unmodified installed Claude Code under its stated commercial conditions,
including retaining its supported authentication methods and direct end-user
credentials/billing. This is not a policy rejection of Claude or permission to
resell access. Its exact product mode still needs verification when implemented.
See [headless usage](https://code.claude.com/docs/en/headless) and
[legal/compliance requirements](https://code.claude.com/docs/en/legal-and-compliance).

## Bounded live evidence

On Windows x64, macOS 26.2 arm64 and Ubuntu 24.04 x64 under WSL2 with Codex
0.164.0, separate development feasibility probes:

- initialized the stable protocol and read a sanitized signed-in state;
- observed Windows sandbox readiness `ready` on Windows;
- created an ephemeral thread in a synthetic directory with read-only scope,
  network access false, `untrusted` approval and a user reviewer;
- received message deltas and a `completed` turn for a short synthetic text task;
- started a second text task, interrupted it and received `interrupted`;
- observed no tool-execution items, unsubscribed the thread, closed stdin, and
  observed the app-server exit with code 0.

The macOS and WSL2 follow-ups each verified the exact synthetic response
`ORGANIS_PROBE_OK` across six real model message deltas. Each interrupted the
second turn after its first message delta while the turn was still active, then
observed `interrupted` and exit code 0.

The initial macOS probe exceeded its 15-second MCP status query deadline before
starting a turn. A bounded retry allowed up to 90 seconds for that query and
returned in 12.9 seconds. This timeout change applies only to the private probe;
the product's connection check does not query MCP status and retains its existing
deadline. Installed Codex 0.167.0 was also checked on macOS and returned
`CODEX_VERSION_UNSUPPORTED`; the tested compatibility set remains 0.164.0.

The probe disabled hooks, apps, plugins, shell tools and native subagents. An
empty `mcp_servers={}` override did **not** remove configured servers, so the probe
also disabled enumerated servers explicitly in the thread configuration. Do not
treat an empty configuration object as proof of isolation. No private workspace,
account identifier, server name, credential or transcript is included here.

This is text-task protocol evidence, not proof that arbitrary command descendants
terminate, that file-writing tasks are scoped on every OS, or that every fresh
Mac/Linux installation works. WSL2 evidence does not establish bare-metal Linux
acceptance. The product's connection check does not create these probe threads
or make model requests.

## R04 implementation gates

The [workspace and permission contract](../specs/workspace-permissions.md) defines
the R04 project/file registry, native OS sandbox behavior and four approval modes:
manual, plan preapproval, automatic except risky actions, and explicit full access.
It is a design contract, not a change to R03 capabilities. Validate each mode's
authority and enforcement against the selected execution protocol version; the
0.164.0 connection check does not establish permission-profile or task support.

M1 releases a workspace only after termination is verified. A Codex terminal turn
status alone does not prove all tool processes or external integrations stopped.
Version 0.164.0 exposes background-terminal list/terminate/clean methods only in
its experimental schema; they are not part of this stable connection contract.
Even such a list must not be mistaken for containment of arbitrary descendants.

Before enabling tasks, define and test process ownership and termination on each
OS, explicit integration/hook policy, scoped workspace enforcement, approval
denial/expiry, real authentication failure, durable provider identities and
owner-loss recovery. Preserve M1's uncertain-termination lease behavior. Do not
add an implicit permission bypass or a protocol-only lease-release exception.
No SQLite migration or change to the running M1 coordinator is needed for R03.

The [implemented connection contract](../specs/codex-connection-check.md) provides
the first reusable adapter component. R03 has a recorded first-adapter decision
and bounded feasibility evidence; R04/M2 execution acceptance remains open.
