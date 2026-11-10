import { readFileSync } from 'node:fs';

// Application releases are independent of the bundled runtime library version.
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
