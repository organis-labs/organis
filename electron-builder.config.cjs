// Native build orchestration supplies the output directory and signing identity.
// Publishing is deliberately disabled by scripts/build.mjs.
module.exports = {
  appId: 'org.organislabs.organis',
  productName: 'Organis',
  directories: { app: 'apps/desktop' },
  asar: true,
  icon: 'build/icon.png',
  npmRebuild: false,
  files: ['**/*', '!entitlements.mac.plist'],
  publish: {
    provider: 'github', owner: 'organis-labs', repo: 'organis',
    channel: 'beta', releaseType: 'prerelease'
  },
  generateUpdatesFilesForAllChannels: false,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'organis-desktop-${version}-windows-x64.${ext}',
    // Until a Windows certificate is configured, do not discover personal keys.
    signExecutable: false
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    executableName: 'organis',
    category: 'Utility',
    artifactName: 'organis-desktop-${version}-linux-x64.${ext}'
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    artifactName: 'organis-desktop-${version}-macos-arm64.${ext}',
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    notarize: false
  }
};
