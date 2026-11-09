// This file is copied to the stable root of each standalone CLI bundle. Updates
// select an immutable version directory rather than replacing a running binary.
const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');

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
async function launch(root = __dirname, args = process.argv.slice(2)) {
  const bundle = selectBundle(root);
  const executable = join(bundle, process.platform === 'win32' ? 'node.exe' : 'node');
  safePath(executable, false);
  let source = bundle;
  for (const part of ['apps', 'cli', 'src']) { source = join(source, part); safePath(source, true); }
  const entry = join(source, 'main.mjs');
  safePath(entry, false);
  const child = spawn(executable, [entry, ...args], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, ORGANIS_INSTALL_ROOT: resolve(root) }, windowsHide: true, detached: true
  });
  // A private IPC channel forwards terminal control without Windows kill()
  // force-termination or duplicate foreground-group signals on Unix.
  const interrupt = (signal = 'SIGINT') => {
    if (args[0] === 'run') {
      if (child.connected) child.send({ type: 'organis:interrupt' }, () => {});
    } else child.kill(signal);
  };
  const parentControl = message => { if (message?.type === 'organis:interrupt') interrupt(); };
  const sigint = () => interrupt('SIGINT');
  const sigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  process.on('message', parentControl);
  process.on('disconnect', interrupt);
  try {
    return await new Promise((resolveExit, reject) => {
      child.once('error', () => reject(new Error('Unable to launch the installed CLI')));
      child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    process.off('message', parentControl);
    process.off('disconnect', interrupt);
    if (process.connected) process.disconnect();
  }
}
module.exports = { selectBundle, launch };
if (require.main === module) {
  launch().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Organis: ${error.message}`); process.exitCode = 1;
  });
}
