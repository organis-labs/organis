// This file is copied to the stable root of each standalone CLI bundle. Updates
// select an immutable version directory rather than replacing a running binary.
const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function safePath(path, directory) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || !samePath(realpathSync(path), resolve(path))) throw new Error('Invalid CLI installation path');
}
function selectBundle(root) {
  root = resolve(root);
  safePath(root, true);
  const state = join(root, '.organis');
  try { safePath(state, true); } catch (error) { if (error.code === 'ENOENT') return root; throw error; }
  const pointer = join(state, 'current.json');
  try { safePath(pointer, false); } catch (error) { if (error.code === 'ENOENT') return root; throw error; }
  const value = JSON.parse(readFileSync(pointer, 'utf8'));
  if (typeof value.version !== 'string' || value.version.length > 64
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/.test(value.version)) throw new Error('Invalid CLI version pointer');
  const versions = join(state, 'versions');
  safePath(versions, true);
  const bundle = join(versions, value.version);
  safePath(bundle, true);
  return bundle;
}
function launch(root = __dirname, args = process.argv.slice(2)) {
  const bundle = selectBundle(root);
  const executable = join(bundle, process.platform === 'win32' ? 'node.exe' : 'node');
  safePath(executable, false);
  let source = bundle;
  for (const part of ['apps', 'cli', 'src']) { source = join(source, part); safePath(source, true); }
  const entry = join(source, 'main.mjs');
  safePath(entry, false);
  const result = spawnSync(executable, [entry, ...args], {
    stdio: 'inherit', env: { ...process.env, ORGANIS_INSTALL_ROOT: resolve(root) }, windowsHide: true
  });
  if (result.error) throw new Error('Unable to launch the installed CLI');
  return result.status ?? 1;
}
module.exports = { selectBundle, launch };
if (require.main === module) {
  try { process.exitCode = launch(); }
  catch (error) { console.error(`Organis: ${error.message}`); process.exitCode = 1; }
}
