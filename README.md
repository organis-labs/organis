# Organis

Desktop and CLI bootstrap for a general-purpose agent workspace. This initial
version opens a local desktop window and reports CLI version/status. Agent
execution, provider connections, synchronization, and approvals are not implemented.

## Development

Use Node **24.22.2** with its bundled npm.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm test
npm start
npm run cli -- status --json
npm run build
```

The native build packages both applications, runs CLI and desktop renderer smoke
checks, and writes archives plus `manifest.json` and `SHA256SUMS` under `dist/`.

| Native build host | Target | Archive |
| --- | --- | --- |
| Windows x64 | windows-x64 | ZIP |
| macOS Apple Silicon | macos-arm64 | tar.gz |
| Linux x64 | linux-x64 | tar.gz |

Linux needs Electron system libraries, Xvfb (`xvfb-run`), and an unprivileged
account with a functioning Chromium sandbox. Builds never disable the sandbox.
macOS builds require Apple's command-line developer tools and a GUI session for
the renderer smoke check. No cross-compilation or untested architecture support
is implied. WSL execution is reported separately from native Linux coverage.

Extract the desktop archive and launch Organis. Extract the CLI archive and run
`organis.cmd` on Windows or `./organis` on Unix. The CLI includes Node and its
license, so a separate Node installation is not needed. These are **unsigned
development builds**, not installers or production releases. Operating systems
may apply normal downloaded-application trust checks.

## Layout

- `apps/desktop`: isolated Electron shell and local static UI.
- `apps/cli`: headless entry point, independent of Electron.
- `packages/runtime`: bootstrap metadata; no agent loop yet.
- `scripts/build.mjs`: native packaging, smoke checks, checksums, provenance.
- `tests`: CLI behavior checks.

CI is manually orchestrated by private build infrastructure for an explicitly
reviewed full source commit. This public repo has no self-hosted PR workflow.
Outputs are retained as Actions artifacts, not published releases. The manifest
records source/tool versions; checksums detect corruption, not a compromised host.

Licensing has not been selected yet. No open-source license grant is implied by
this initial public scaffold.

`NODE-LICENSE.txt` is the unmodified third-party Node v24.22.2 license from
https://github.com/nodejs/node/blob/v24.22.2/LICENSE, bundled with the CLI runtime.
Electron packaging preserves Electron and Chromium license files.
