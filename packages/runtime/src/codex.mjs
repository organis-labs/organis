import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { prepareCodexProfile } from './codex-profile.mjs';
import { codexVersionRange, parseCodexVersion, supportsCodexVersion } from './agent-compatibility.mjs';
const messages = Object.freeze({
  CODEX_NOT_FOUND: 'Codex was not found. Install Codex CLI or select its executable.',
  CODEX_EXECUTABLE_INVALID: 'Select an absolute path to an existing, accessible Codex executable.',
  CODEX_SHIM_UNSUPPORTED: 'Windows command shims are not supported. Select the native codex.exe installed by Codex.',
  CODEX_VERSION_UNSUPPORTED: `Use a stable Codex CLI version in the supported range ${codexVersionRange}.`,
  CODEX_MODEL_UNAVAILABLE: 'The selected model is missing from this Codex provider catalog. Check the model ID or use the Codex default.',
  CODEX_START_FAILED: 'Codex could not start. Check that the selected executable runs on this device.',
  CODEX_PROTOCOL_ERROR: 'Codex returned an unexpected response. Check the supported version and try again.',
  CODEX_CHECK_TIMEOUT: 'The Codex connection check timed out. Check Codex locally, then try again.',
  CODEX_CHECK_CANCELLED: 'The Codex connection check was cancelled.',
  CODEX_EXIT_FAILED: 'Codex did not exit cleanly after the check. Check Codex locally before retrying.',
  CODEX_AUTH_REQUIRED: 'Sign in using codex login in your terminal, then check again.',
  CODEX_SANDBOX_REQUIRED: 'Finish Windows sandbox setup in Codex before running tasks.',
  CODEX_LOGIN_FAILED: 'Codex sign-in did not complete. Close any other Codex login, then try again.',
  CODEX_AUTH_UNKNOWN: 'Codex returned an unknown authentication status. Check Codex locally.',
  CODEX_RUN_TIMEOUT: 'The Codex task exceeded its time limit.',
  CODEX_RUN_FAILED: 'The Codex turn did not complete.',
  CODEX_POLICY_UNVERIFIED: 'Codex did not confirm the read-only execution policy.',
  CODEX_MCP_UNSUPPORTED: 'The read-only preview requires a Codex configuration without MCP server definitions.'
});
export function codexFault(code) { return Object.assign(new Error(messages[code]), { code }); }
const fault = codexFault;

export async function verifyCodexModel(connection, model) {
  if (model === undefined) return;
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 10; page++) {
    const result = await connection.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw fault('CODEX_PROTOCOL_ERROR');
    if (result.data.some(entry => entry?.model === model)) return;
    cursor = result.nextCursor;
    if (cursor === null) throw fault('CODEX_MODEL_UNAVAILABLE');
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw fault('CODEX_PROTOCOL_ERROR');
    seen.add(cursor);
  }
  throw fault('CODEX_PROTOCOL_ERROR');
}

export function codexEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([name]) =>
    /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|COMSPEC|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|CODEX_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|LANG|LC_ALL)$/i.test(name)));
}

export function codexLoginEnvironment(source = process.env, platform = process.platform) {
  const env = codexEnvironment(source);
  if (platform === 'linux') {
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (typeof source[key] === 'string') env[key] = source[key];
    }
  }
  return env;
}

export async function resolveCodex({ executable, env = process.env, platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const explicit = executable !== undefined;
  if (explicit && (typeof executable !== 'string' || !paths.isAbsolute(executable) || executable.includes('\0'))) {
    throw fault('CODEX_EXECUTABLE_INVALID');
  }
  const search = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const candidates = explicit ? [executable] : search.split(platform === 'win32' ? ';' : ':')
    .filter(directory => paths.isAbsolute(directory))
    .flatMap(directory => (platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'])
      .map(name => paths.join(directory, name)));
  let shim = false;
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      if (platform === 'win32' && !/\.exe$/i.test(candidate)) {
        if (/\.(cmd|bat)$/i.test(candidate)) shim = true;
        continue;
      }
      await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw fault('CODEX_EXECUTABLE_INVALID');
    }
  }
  throw fault(shim ? 'CODEX_SHIM_UNSUPPORTED' : explicit ? 'CODEX_EXECUTABLE_INVALID' : 'CODEX_NOT_FOUND');
}

// No shell, terminal scraping, credential file access, or persistent session.
// Injectable process dependencies and platform keep protocol tests portable.
export function createCodexChecker({ launch = spawn, resolve = resolveCodex, timeoutMs = 15000, closeMs = 2000, platform = process.platform } = {}) {
  return async function check({ executable, profile, signal } = {}) {
    let directory;
    let connection;
    let selected;
    let version;
    let env;
    let profileArgs;
    const abort = new AbortController();
    const cancel = () => abort.abort(fault('CODEX_CHECK_CANCELLED'));
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort.abort(fault('CODEX_CHECK_TIMEOUT')), timeoutMs);
    let result;
    try {
      abort.signal.throwIfAborted();
      selected = await resolve({ executable });
      ({ env, args: profileArgs } = await prepareCodexProfile(profile, codexEnvironment()));
      directory = await mkdtemp(path.join(tmpdir(), 'organis-codex-check-'));
      abort.signal.throwIfAborted();
      connection = start(['--version']);
      const output = await connection.version();
      version = parseCodexVersion(output);
      if (!supportsCodexVersion(version)) throw fault('CODEX_VERSION_UNSUPPORTED');
      await connection.close();
      connection = start(['app-server', '--stdio', '--disable', 'apps', '--disable', 'plugins',
        '--disable', 'hooks', '--disable', 'multi_agent', '--disable', 'daemon_auto_start', ...profileArgs]);
      await connection.request('initialize', { clientInfo: { name: 'organis_connection_check', version: '0.1.0' }, capabilities: { experimentalApi: false } });
      connection.notify('initialized');
      const account = await connection.request('account/read', { refreshToken: false });
      const auth = account?.account;
      if (typeof account?.requiresOpenaiAuth !== 'boolean' || (auth !== null && !['chatgpt', 'apiKey'].includes(auth?.type))) {
        throw fault('CODEX_AUTH_UNKNOWN');
      }
      let sandbox = 'not-checked';
      if (platform === 'win32') {
        const readiness = await connection.request('windowsSandbox/readiness', {});
        if (!['ready', 'notConfigured', 'updateRequired'].includes(readiness?.status)) throw fault('CODEX_PROTOCOL_ERROR');
        sandbox = readiness.status;
      }
      const authenticated = auth !== null;
      const code = (profile ? auth?.type !== 'chatgpt' : !authenticated && account.requiresOpenaiAuth) ? 'CODEX_AUTH_REQUIRED'
        : sandbox !== 'not-checked' && sandbox !== 'ready' ? 'CODEX_SANDBOX_REQUIRED' : null;
      result = { ok: !code, code, message: code === 'CODEX_AUTH_REQUIRED' && profile ? (profile === 'desktop'
          ? 'Select Sign in to Codex to connect this Organis profile.'
          : 'Run organis agent codex login, then check again.')
          : code ? messages[code] : 'Codex connection verified. This check does not run a task.',
        authentication: { status: authenticated ? 'signed-in' : account.requiresOpenaiAuth ? 'signed-out' : 'not-required', kind: auth?.type ?? null }, sandbox };
    } catch (error) {
      const code = Object.hasOwn(messages, error.code) ? error.code : 'CODEX_PROTOCOL_ERROR';
      result = { ok: false, code, message: messages[code] };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      try {
        await connection?.close();
        if (result?.ok && connection?.error) throw connection.error;
      }
      catch { result = { ok: false, code: 'CODEX_EXIT_FAILED', message: messages.CODEX_EXIT_FAILED }; }
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    return { agent: 'codex', executable: selected ?? null, version: version ?? null, ...result,
      capabilities: { connectionCheck: true, taskExecution: false, interactiveApproval: false, resume: false } };

    function start(args) {
      return new CodexConnection(launch(selected, args, { cwd: directory, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), abort.signal, closeMs);
    }
  };
}
export const checkCodex = createCodexChecker();

export async function loginCodex({ executable, profile, signal, deviceAuth = false, terminal = false }) {
  if (profile === undefined) throw new TypeError('An Organis Codex profile is required.');
  const before = await checkCodex({ executable, profile, signal });
  if (!before.ok && !['CODEX_AUTH_REQUIRED', 'CODEX_SANDBOX_REQUIRED'].includes(before.code)) return before;
  const { env, args } = await prepareCodexProfile(profile, codexLoginEnvironment());
  const abort = new AbortController();
  const cancel = () => abort.abort(fault('CODEX_CHECK_CANCELLED'));
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abort.abort(fault('CODEX_LOGIN_FAILED')), 15 * 60 * 1000);
  try {
    if (signal?.aborted) cancel();
    abort.signal.throwIfAborted();
    // Codex opens the provider's browser flow and owns the credentials and callback.
    const child = spawn(before.executable, ['login', ...args, ...(deviceAuth ? ['--device-auth'] : [])], {
      cwd: env.CODEX_HOME, env, shell: false, windowsHide: true, stdio: terminal ? 'inherit' : 'ignore',
      signal: abort.signal
    });
    let killTimer;
    const stop = () => { killTimer = setTimeout(() => child.kill('SIGKILL'), 1500); };
    abort.signal.addEventListener('abort', stop, { once: true });
    const exitCode = await new Promise(resolve => {
      child.once('error', () => {});
      child.once('close', resolve);
    }).finally(() => {
      clearTimeout(killTimer);
      abort.signal.removeEventListener('abort', stop);
    });
    abort.signal.throwIfAborted();
    if (exitCode !== 0) throw fault('CODEX_LOGIN_FAILED');
    const after = await checkCodex({ executable: before.executable, profile, signal });
    if (after.ok && after.authentication?.kind !== 'chatgpt') throw fault('CODEX_LOGIN_FAILED');
    return after;
  } catch (error) {
    const code = error.code === 'CODEX_CHECK_CANCELLED' ? error.code : 'CODEX_LOGIN_FAILED';
    return { ok: false, code, message: messages[code], version: before.version };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export class CodexConnection {
  constructor(child, signal, closeMs, onMessage) {
    this.child = child;
    this.signal = signal;
    this.closeMs = closeMs;
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = '';
    this.bytes = 0;
    this.decoder = new StringDecoder('utf8');
    this.raw = '';
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.failed = new Promise(resolve => { this.resolveFailed = resolve; });
    this.onAbort = () => this.fail(signal.reason);
    signal.addEventListener('abort', this.onAbort, { once: true });
    child.stdin.on('error', () => this.fail(fault('CODEX_START_FAILED')));
    child.stdout.on('error', () => this.fail(fault('CODEX_START_FAILED')));
    child.stderr.on('error', () => this.fail(fault('CODEX_START_FAILED')));
    child.stderr.on('data', chunk => this.count(chunk)); // Never expose provider stderr or account data.
    child.stdout.on('data', chunk => {
      this.count(chunk);
      if (this.error) return;
      const text = this.decoder.write(chunk);
      if (this.rawMode) { this.raw += text; return; }
      this.buffer += text;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0 && !this.error) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
          if (message.method) {
            if (onMessage) onMessage(message);
            else if (message.id !== undefined) this.send({ id: message.id, error: { code: -32601, message: 'Connection checks do not support server requests.' } });
          } else if (this.pending.has(message.id)) {
            const item = this.pending.get(message.id); this.pending.delete(message.id);
            if (message.error || !Object.hasOwn(message, 'result')) item.reject(fault('CODEX_PROTOCOL_ERROR'));
            else item.resolve(message.result);
          }
        } catch (error) {
          this.fail(Object.hasOwn(messages, error.code) ? error : fault('CODEX_PROTOCOL_ERROR'));
        }
      }
    });
    child.once('error', () => this.fail(fault('CODEX_START_FAILED')));
    child.once('close', code => {
      this.exitCode = code;
      this.ended = true;
      signal.removeEventListener('abort', this.onAbort);
      for (const item of this.pending.values()) item.reject(this.error ?? fault('CODEX_PROTOCOL_ERROR'));
      this.pending.clear();
      this.resolveClosed();
    });
    if (signal.aborted) this.onAbort();
  }
  count(chunk) { if ((this.bytes += chunk.length) > 1024 * 1024) this.fail(fault('CODEX_PROTOCOL_ERROR')); }
  fail(error) {
    this.error ??= error;
    this.resolveFailed();
    for (const item of this.pending.values()) item.reject(this.error);
    this.pending.clear();
    if (!this.ended) this.child.kill('SIGKILL'); // Only the live handle created by this check.
  }
  send(message) {
    if (this.error) throw this.error;
    if (this.ended) throw fault('CODEX_PROTOCOL_ERROR');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  notify(method) { this.send({ method }); }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async version() {
    this.rawMode = true;
    await Promise.race([this.closed, this.failed]);
    if (this.error) throw this.error;
    if (this.exitCode !== 0) { this.error = fault('CODEX_START_FAILED'); throw this.error; }
    return this.raw + this.decoder.end();
  }
  async close() {
    if (!this.ended) this.child.stdin.end();
    if (!await this.waitClose()) {
      this.child.kill('SIGKILL');
      if (!await this.waitClose()) {
        // A child holding inherited pipes must not keep the caller hung forever.
        // Report unverified closure; never claim that descendants were stopped.
        this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
        this.child.unref();
        this.signal.removeEventListener('abort', this.onAbort);
        throw fault('CODEX_EXIT_FAILED');
      }
      throw fault('CODEX_EXIT_FAILED');
    }
    if (this.exitCode !== 0 && !this.error) throw fault('CODEX_EXIT_FAILED');
  }
  async waitClose() {
    if (this.ended) return true;
    let timer;
    const result = await Promise.race([this.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.closeMs); })]);
    clearTimeout(timer);
    return result;
  }
}
