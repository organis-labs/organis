// Bundled deterministic fixture. Launched only by LocalRuntime. Never writes to stdout/stderr.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// libuv re-adds these variables from the parent on Windows whenever a spawn env omits them
// (uv_spawn make_program_env). Credential-bearing variable names are never forwarded.
const WIN32_LIBUV_ENV = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'TEMP',
  'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
const ALLOWED_ENV = ['ORGANIS_FIXTURE', 'ELECTRON_RUN_AS_NODE', 'SystemRoot',
  ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []),
  ...(process.platform === 'win32' ? WIN32_LIBUV_ENV : [])];

// Windows can also signal the child. Cancellation is recorded by the owner first.
process.on('SIGINT', () => {});

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function runGrandchild() {
  setInterval(() => {}, 1000);
  process.on('disconnect', () => process.exit(0));
  if (!process.connected) process.exit(0);
}

function send(message) {
  return new Promise(resolve => {
    try {
      if (!process.connected) return resolve();
      process.send(message, () => resolve());
    } catch { resolve(); }
  });
}

function envLeakKeys() {
  const fold = process.platform === 'win32' ? key => key.toLowerCase() : key => key;
  const allowed = new Set(ALLOWED_ENV.map(fold));
  return Object.keys(process.env).filter(key => !allowed.has(fold(key)));
}

async function runChild() {
  const mode = argOf('mode', 'complete');
  const durationMs = Number(argOf('duration', '0'));
  const envKeys = Object.keys(process.env).sort();
  const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), '--role', 'grandchild'], {
    shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env
  });
  let grandchildExited = false;
  const grandchildGone = new Promise(resolve => {
    grandchild.once('exit', () => { grandchildExited = true; resolve(); });
    grandchild.once('error', () => { grandchildExited = true; resolve(); });
  });
  const stopGrandchild = async () => {
    if (!grandchildExited) {
      try { grandchild.kill(); } catch { /* already gone */ }
      await Promise.race([grandchildGone, new Promise(resolve => setTimeout(resolve, 2000))]);
    }
  };
  let ending = false;
  const cancelled = async () => {
    if (ending) return;
    ending = true;
    await stopGrandchild();
    process.exit(130);
  };
  process.on('disconnect', cancelled);
  process.on('message', message => { if (message?.type === 'cancel') cancelled(); });
  if (!process.connected) { await cancelled(); return; }

  await send({ type: 'ready', pid: process.pid, grandchildPid: grandchild.pid ?? null, envKeys, cwd: process.cwd() });
  if (ending) return;
  if (envLeakKeys().length) {
    ending = true;
    await send({ type: 'result', ok: false, code: 'ENV_LEAK' });
    await stopGrandchild();
    process.exit(4);
  }
  if (mode === 'wait') return;
  setTimeout(async () => {
    if (ending) return;
    ending = true;
    await stopGrandchild();
    if (mode === 'complete') {
      await send({ type: 'result', ok: true });
      process.exit(0);
    }
    await send({ type: 'result', ok: false, code: 'FIXTURE_FAILED' });
    process.exit(3);
  }, durationMs);
}

const role = argOf('role', '');
if (role === 'grandchild') runGrandchild();
else if (role === 'child') runChild();
else process.exit(2);
