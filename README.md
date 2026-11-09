# Organis

Desktop and CLI foundation for a general-purpose agent workspace. Both clients
run a bundled deterministic fixture through a shared local execution runtime,
with saved state, ordered events, command deduplication and cancellation.
Codex connection checks are available; real agent task execution, provider
integrations, synchronization and interactive approvals are not implemented.
See the [execution contract](docs/local-execution.md)
for ownership, recovery and scope limitations.

## Development

Use Node **24.22.2** with its bundled npm.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
node node_modules/esbuild/install.js
npm test
npm start
npm run cli -- status --json
npm run build
npm run verify:platform
```

The native build packages both applications, runs CLI and desktop renderer smoke
checks, and writes installers, update metadata, CLI archives, `manifest.json`,
and `SHA256SUMS` under `dist/`. Build commands never publish a release.

`verify:platform` builds development application directories with the same runtime
resources and standalone CLI, then exercises completion, persistence, duplicate
commands, failure and desktop cancellation. It does not sign, notarize, create
installers or publish. The PR workflow runs this on GitHub-hosted Windows x64,
macOS arm64 and Linux x64 runners without maintainer secrets or personal hosts.
Its result is package/runtime verification, not release-installation acceptance.

## Local execution

Check an installed Codex CLI without starting a task:

```sh
organis agent codex check --json
organis agent codex check --executable /absolute/path/to/codex --json
```

The desktop offers **Check connection** and an executable picker. Currently the
verified version is Codex **0.164.0**; other versions are reported as unverified.
On Windows select the native `codex.exe`, not an npm `.cmd` shim. Sign in through
`codex login` in your terminal. Organis does not import credentials or start login
automatically. See the [connection contract](docs/specs/codex-connection-check.md)
for error handling, privacy and actual platform coverage.

In the desktop app, choose a trusted workspace and start a test. Select Complete,
Fail or Wait for cancellation, then inspect the saved run and events. Cancelling
is a request until process termination is confirmed. Quitting the desktop requests
cancellation of its own runs and waits for cleanup; it does not cancel runs owned
by a separate CLI process. On macOS, closing the last window leaves the app running.

The same fixture works without Electron or a display:

```sh
organis run fixture --workspace /path/to/workspace --json
organis run list --json
organis run show <run-id> --json
organis run events <run-id> --after 0 --json
organis run cancel <run-id> --json
organis run reconcile --json
```

Use a Windows path on Windows, quoting paths with spaces. In a source checkout,
replace `organis` with `npm run cli --`. Both clients use `~/.organis/runtime` by
default. The CLI accepts `--state-dir <directory>` for isolated testing. A fixture
emits an `accepted` JSON record followed by its final `result`; other commands emit
one record. Supply the same UUID `--command-id` to reconcile a repeated submission;
changed payloads with the same ID are rejected. No automatic retry replays work.
Ctrl+C requests cancellation for a run started by that invocation and waits for
termination. On a duplicate submission it stops observing without cancelling the
original owner's run. A second Ctrl+C stops waiting without claiming termination;
inspect the saved state and reconcile uncertain work. The standalone launcher waits
for the CLI to drain its first cancellation request.

The fixture is trusted bundled code, not an OS sandbox or a general shell runner.
It does not edit workspace files. Requests for unsupported enforcement are rejected.
Private local state must stay out of Git and shared folders. Persistent background
hosting, real approval decisions and remote/mobile transport are later milestones.

| Native build host | Target | Desktop / CLI |
| --- | --- | --- |
| Windows x64 | windows-x64 | Per-user NSIS installer / tar.gz |
| macOS Apple Silicon | macos-arm64 | Developer ID signed DMG and ZIP / tar.gz |
| Linux x64 | linux-x64 | AppImage / tar.gz |

Linux needs Electron system libraries, Xvfb (`xvfb-run`), and an unprivileged
account with a functioning Chromium sandbox. Builds never disable the sandbox.
On the disposable Ubuntu CI runner, an AppArmor profile allows user namespaces
only for the packaged test executable; global namespace restrictions stay enabled.
macOS builds require Apple's command-line developer tools and a GUI session for
the renderer smoke check. No cross-compilation or untested architecture support
is implied. WSL execution is reported separately from native Linux coverage.

Install the desktop application from a [GitHub Release](https://github.com/organis-labs/organis/releases).
On Linux, make the AppImage executable and launch it from a writable location;
the host must support AppImage/FUSE. Extract the CLI archive and run
`organis.cmd` on Windows or `./organis` on Unix. The CLI includes Node and its
license, so a separate Node installation is not needed. Windows builds are unsigned;
operating systems may apply normal downloaded-application trust checks. These
are early beta builds, not a complete agent runtime.

## Desktop updates

Installed releases check the public GitHub beta feed at startup and every four
hours, then download a newer version automatically. Choose **Restart and install**
when ready; closing the app alone does not install an update. Downgrades are
disabled. No GitHub account or maintainer token is needed on users' machines.
Development mode, smoke tests, and Linux launches outside the AppImage do not
check for updates.

## CLI updates

Launch the extracted bundle through `organis.cmd` (Windows) or `./organis` (Unix).
Run `organis update --check` to check the public beta feed and `organis update` to
download and install a newer version. No account or separate Node installation
is required. The launcher must remain in a writable directory.

Updates verify the release manifest and archive checksum, reject unsafe archive
paths/links, and smoke-test the downloaded CLI. Each version is installed under
`.organis/versions/`; the launcher switches through an atomic version pointer.
Running processes and older versions are left intact. Downgrades are refused.
The CLI never updates itself during ordinary commands. Source checkouts can check
for updates, but cannot be replaced by this command. If an update process crashes,
confirm no update is still running before removing its empty `.organis/update.lock`
directory to retry. Old versions are retained deliberately.

macOS release builds require `ORGANIS_MAC_SIGNING_IDENTITY` referencing an existing
Developer ID Application identity in the build user's keychain. Required
`ORGANIS_NOTARY_PROFILE` references an existing notarytool keychain profile. The
manifest records signing and notarization separately; releases require both.
Never put certificates, passwords,
or keychain exports in this repository.

## Code review guidance

CodeRabbit uses the repository's `AGENTS.md` and the path-specific instructions in
`.coderabbit.yaml`. The configuration maps `docs/local-execution.md` to the runtime,
clients and their verification code, and `docs/roadmap.md` to the whole repository.
Update the execution contract when behavior changes; mark future milestones and
contract-only entities explicitly so reviewers can distinguish them from current
requirements. Change the configuration's `reviews.path_instructions` to add
area-specific review criteria, and `knowledge_base.code_guidelines.filePatterns`
to map another domain document to the code it governs.

## Layout

- `apps/desktop`: isolated Electron shell and local static UI.
- `apps/cli`: headless entry point, independent of Electron.
- `packages/runtime`: local execution contracts, persistence and deterministic fixture; no real agent adapter yet.
- `scripts/build.mjs`: native packaging, smoke checks, checksums, provenance.
- `tests`: CLI behavior checks.

Release CI is orchestrated by private build infrastructure for an explicitly
selected full source commit after all three main CI targets pass. The coordinator
checks every five minutes, increases the beta version when needed, and waits for
the version commit's CI before building and publishing. GitHub scheduling may be
delayed; merges before publication may be combined into one release. Failed builds
require maintainer inspection and manual retry. Public PR verification uses disposable GitHub-hosted
runners; this repo has no self-hosted PR workflow.
Successful complete release builds are validated and published to this repository's
GitHub Releases by a separate publisher. The manifest records source/tool versions;
checksums detect corruption, not a compromised host. The initial build must be
installed manually before its updater can install subsequent versions.

Licensing has not been selected yet. No open-source license grant is implied by
this initial public scaffold.

`NODE-LICENSE.txt` is the unmodified third-party Node v24.22.2 license from
https://github.com/nodejs/node/blob/v24.22.2/LICENSE, bundled with the CLI runtime.
Electron packaging preserves Electron and Chromium license files.
CLI update dependencies' license texts are included in `THIRD-PARTY-LICENSES.txt`.
