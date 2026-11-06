# Organis contributor guidance

This repository contains the Organis desktop application and CLI. Both are early
bootstrap applications, not a complete agent runtime.

- Keep desktop UI and Electron dependencies out of CLI and runtime modules.
- Keep agent CLI adapters separate from model provider adapters.
- Local use must not require a maintainer account or hosted service.
- Never commit credentials, personal instructions, host paths, or operational data.
- Public workflows must not execute untrusted contributions on self-hosted runners.
- Keep build scripts public and reproducible; private infrastructure orchestrates
  builds of an explicitly selected immutable source commit.
- Inspect package scripts before running checks. Verify affected behavior and
  report actual OS coverage rather than claiming untested platforms work.
- Do not merge PRs or rewrite remote history without explicit user approval.

Read README.md for the current layout and commands. More specific guidance applies
within its directory. Preserve unrelated work and use synthetic test data.
