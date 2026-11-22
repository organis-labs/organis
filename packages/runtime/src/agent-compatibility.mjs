const minimumCodexMinor = 164;
const maximumCodexMinor = 171;
export const codexVersionRange = `0.${minimumCodexMinor}.0–0.${maximumCodexMinor}.0`;

export function parseCodexVersion(output) {
  return /^codex-cli ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\s*$/.exec(output)?.[1];
}

export function supportsCodexVersion(version) {
  const match = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? '');
  if (!match) return false;
  const minor = Number(match[1]);
  return minor >= minimumCodexMinor
    && (minor < maximumCodexMinor || (minor === maximumCodexMinor && match[2] === '0'));
}

export function isAgentModelId(model) {
  return typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model);
}
