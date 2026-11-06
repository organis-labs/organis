import { readFileSync } from 'node:fs';

export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export function getStatus() {
  return { name: 'Organis', version, stage: 'bootstrap', platform: process.platform,
    arch: process.arch, runtime: process.version, agentRuntimeAvailable: false };
}
