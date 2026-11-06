# Organis

Desktop and CLI bootstrap for a general-purpose agent workspace. This initial
version opens a local desktop window and reports CLI version/status. Agent
execution, provider connections, synchronization, and approvals are not implemented.

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
```

The native build packages both applications, runs CLI and desktop renderer smoke
checks, and writes installers, update metadata, CLI archives, `manifest.json`,
and `SHA256SUMS` under `dist/`. Build commands never publish a release.

| Native build host | Target | Desktop / CLI |
| --- | --- | --- |
| Windows x64 | windows-x64 | Per-user NSIS installer / tar.gz |
| macOS Apple Silicon | macos-arm64 | Developer ID signed DMG and ZIP / tar.gz |
| Linux x64 | linux-x64 | AppImage / tar.gz |

Linux needs Electron system libraries, Xvfb (`xvfb-run`), and an unprivileged
account with a functioning Chromium sandbox. Builds never disable the sandbox.
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

## Layout

- `apps/desktop`: isolated Electron shell and local static UI.
- `apps/cli`: headless entry point, independent of Electron.
- `packages/runtime`: bootstrap metadata; no agent loop yet.
- `scripts/build.mjs`: native packaging, smoke checks, checksums, provenance.
- `tests`: CLI behavior checks.

CI is manually orchestrated by private build infrastructure for an explicitly
reviewed full source commit. This public repo has no self-hosted PR workflow.
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
