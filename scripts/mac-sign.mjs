// electron-builder 26.18.0 resolves a certificate hash, but its default signer
// replaces that hash with the display name. Names can match multiple identities.
// Keep the resolved hash through its custom-sign hook and use the same signer.
export async function signMac(options, signer) {
  if (!/^[a-f0-9]{40}$/i.test(options.identity ?? '')) {
    throw new Error('macOS signing requires a resolved certificate SHA-1 hash');
  }
  signer ??= (await import('app-builder-lib/out/codeSign/macCodeSign.js')).sign;
  return signer({ ...options, identityValidation: true });
}
