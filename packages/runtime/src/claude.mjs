import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { codexEnvironment } from './codex.mjs';

const messages = Object.freeze({
  CLAUDE_NOT_FOUND: 'Claude Code was not found. Install Claude Code or select its executable.',
  CLAUDE_EXECUTABLE_INVALID: 'Select an absolute path to an existing, accessible Claude Code executable.',
  CLAUDE_SHIM_UNSUPPORTED: 'Windows command shims are not supported. Select the native Claude Code .exe.',
  CLAUDE_START_FAILED: 'Claude Code could not start. Check that the selected executable runs on this device.',
  CLAUDE_VERSION_INVALID: 'Claude Code returned an unrecognized version. Check the selected executable.',
  CLAUDE_AUTH_CHECK_FAILED: 'Claude Code could not report its authentication status. Check that claude auth status works in a terminal.',
  CLAUDE_PROTOCOL_ERROR: 'Claude Code returned an unexpected response.',
  CLAUDE_AUTH_REQUIRED: 'Run the official claude auth login command for this Organis profile, then check again.',
  CLAUDE_PROFILE_UNVERIFIED: 'Claude Code did not confirm this Organis profile. Install a release that reports configDirectory (2.1.268 or newer).',
  CLAUDE_CHECK_CANCELLED: 'The Claude Code connection check was cancelled.',
  CLAUDE_CHECK_TIMEOUT: 'The Claude Code connection check timed out. Check Claude Code locally, then try again.'
});

const authKinds = new Map([
  ['claude.ai', 'subscription'],
  ['oauth_token', 'oauth-token'],
  ['api_key', 'api-key'],
  ['api_key_helper', 'api-key-helper'],
  ['third_party', 'third-party']
]);

const fault = code => Object.assign(new Error(messages[code]), { code });

function claudeEnvironment(source = process.env) {
  const env = codexEnvironment(source);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'CODEX_HOME') delete env[key];
  }
  if (process.platform === 'darwin') {
    const { username } = userInfo();
    env.USER = env.LOGNAME = username;
    if (source.__CF_USER_TEXT_ENCODING) env.__CF_USER_TEXT_ENCODING = source.__CF_USER_TEXT_ENCODING;
  }
  return env;
}

function profileDirectory(profile, root) {
  if (!['cli', 'desktop'].includes(profile)) throw new TypeError('Invalid Organis Claude Code profile.');
  return path.join(root, profile);
}

const defaultProfileRoot = () => path.join(homedir(), '.organis', 'claude');

async function claudeProfilePath(profile, root) {
  const directory = profileDirectory(profile, root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const expected = profileDirectory(profile, await realpath(root));
  const actual = await realpath(directory);
  if (path.relative(expected, actual) !== '') throw fault('CLAUDE_PROFILE_UNVERIFIED');
  return actual;
}

async function resolveClaude(executable, env) {
  const explicit = executable !== undefined;
  if (explicit && (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0'))) {
    throw fault('CLAUDE_EXECUTABLE_INVALID');
  }
  const windows = process.platform === 'win32';
  const names = windows ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  const search = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const candidates = explicit ? [executable] : [...search.split(path.delimiter), path.join(homedir(), '.local', 'bin')]
    .filter(directory => path.isAbsolute(directory))
    .flatMap(directory => names.map(name => path.join(directory, name)));
  let shim = false;
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      const resolved = await realpath(candidate);
      if (windows && (!/\.exe$/i.test(candidate) || !/\.exe$/i.test(resolved))) {
        if (/\.(cmd|bat)$/i.test(candidate) || /\.(cmd|bat)$/i.test(resolved)) shim = true;
        continue;
      }
      await access(resolved, constants.X_OK);
      return resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw fault('CLAUDE_EXECUTABLE_INVALID');
    }
  }
  throw fault(shim ? 'CLAUDE_SHIM_UNSUPPORTED' : explicit ? 'CLAUDE_EXECUTABLE_INVALID' : 'CLAUDE_NOT_FOUND');
}

export function runClaude(executable, args, { signal, ...options }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let outcome;
    const child = execFile(executable, args, {
      ...options, shell: false, windowsHide: true, killSignal: 'SIGKILL', maxBuffer: 64 * 1024
    }, (error, stdout) => {
      outcome = { error, stdout };
    });
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    // execFile can report a process error before its pipes have closed.
    child.once('close', () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(signal.reason);
      const { error, stdout } = outcome;
      if (error && typeof error.code !== 'number') {
        reject(fault(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'CLAUDE_PROTOCOL_ERROR' : 'CLAUDE_START_FAILED'));
      } else {
        resolve({ exitCode: error?.code ?? 0, stdout });
      }
    });
    child.stdin?.end();
  });
}

export function createClaudeChecker({ execute = runClaude, timeoutMs = 15000, profileRoot = defaultProfileRoot() } = {}) {
  return async function check({ executable, signal, profile = 'cli' } = {}) {
    const abort = new AbortController();
    const cancel = () => abort.abort(fault('CLAUDE_CHECK_CANCELLED'));
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort.abort(fault('CLAUDE_CHECK_TIMEOUT')), timeoutMs);
    const result = { agent: 'claude', executable: null, version: null, authentication: null };
    let cwd;
    try {
      abort.signal.throwIfAborted();
      const env = claudeEnvironment();
      result.executable = await resolveClaude(executable, env);
      env.CLAUDE_CONFIG_DIR = await claudeProfilePath(profile, profileRoot);
      cwd = await mkdtemp(path.join(tmpdir(), 'organis-claude-check-'));
      const options = { cwd, env, signal: abort.signal };
      abort.signal.throwIfAborted();
      const version = await execute(result.executable, ['--version'], options);
      abort.signal.throwIfAborted();
      if (version.exitCode !== 0) throw fault('CLAUDE_START_FAILED');
      result.version = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(version.stdout)?.[1] ?? null;
      if (!result.version) throw fault('CLAUDE_VERSION_INVALID');
      // Preserve CLI-owned credentials, but skip project and user setting sources for this check.
      const auth = await execute(result.executable, ['--setting-sources', '', 'auth', 'status', '--json'], options);
      abort.signal.throwIfAborted();
      if (![0, 1].includes(auth.exitCode)) throw fault('CLAUDE_AUTH_CHECK_FAILED');
      let data;
      try { data = JSON.parse(auth.stdout); }
      catch { throw fault('CLAUDE_AUTH_CHECK_FAILED'); }
      if (typeof data?.configDirectory !== 'string' ||
        path.relative(env.CLAUDE_CONFIG_DIR, data.configDirectory) !== '' ||
        !path.isAbsolute(data.configDirectory)) {
        throw fault('CLAUDE_PROFILE_UNVERIFIED');
      }
      if (auth.exitCode === 1 && data?.loggedIn === false && data.authMethod === 'none') {
        result.authentication = { status: 'signed-out', kind: null };
        throw fault('CLAUDE_AUTH_REQUIRED');
      }
      if (auth.exitCode !== 0 || data?.loggedIn !== true || !authKinds.has(data.authMethod)) {
        throw fault('CLAUDE_PROTOCOL_ERROR');
      }
      result.authentication = { status: 'signed-in', kind: authKinds.get(data.authMethod) };
      return { ...result, ok: true, code: null, message: 'Claude Code connection verified. This check does not run a task.' };
    } catch (error) {
      const code = abort.signal.aborted ? abort.signal.reason.code :
        Object.hasOwn(messages, error.code) ? error.code : 'CLAUDE_PROTOCOL_ERROR';
      return { ...result, ok: false, code, message: messages[code] };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (cwd) await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  };
}

export const checkClaude = createClaudeChecker();

const loginArgs = ['--safe-mode', 'auth', 'login'];
const answerArgs = ['--safe-mode', '--no-chrome', '--strict-mcp-config', '--tools=',
  '--no-session-persistence', '--print', '--', 'What is 35 + 17? Reply with just the number.'];
const unixQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const powershellQuote = value => "'" + value.replace(/['\u2018-\u201b]/gu, quote => quote.repeat(2)) + "'";

// The user runs the official CLI in their terminal. Organis never starts the
// subscription prompt or receives login output, prompts, or answers.
export function formatClaudeTerminalCommand(executable, directory, args, platform = process.platform) {
  if ([executable, directory].some(value => /[\x00-\x1f\x7f\u0080-\u009f\u2028-\u202e\u2066-\u2069]/u.test(value))) {
    throw fault('CLAUDE_EXECUTABLE_INVALID');
  }
  if (platform === 'win32') {
    const quote = powershellQuote;
    const command = [executable, ...args].map(quote).join(' ');
    return [
      '& {',
      '  $ErrorActionPreference = "Stop"',
      '  $allowed = "^(PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|COMPUTERNAME|SYSTEMROOT|SYSTEMDRIVE|WINDIR|OS|PROCESSOR_ARCHITECTURE|TEMP|TMP|COMSPEC|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES[(]X86[)]|COMMONPROGRAMFILES|PROGRAMDATA|LANG|LC_ALL|TERM|WT_SESSION|SESSIONNAME)$"',
      '  $priorClaudeEnv = @(Get-ChildItem Env: | Where-Object Name -NotMatch $allowed)',
      '  try {',
      '    foreach ($entry in $priorClaudeEnv) { [Environment]::SetEnvironmentVariable($entry.Name, $null, "Process") }',
      `    $env:CLAUDE_CONFIG_DIR = ${quote(directory)}`,
      '    Push-Location -LiteralPath $env:CLAUDE_CONFIG_DIR',
      `    try { & ${command} } finally { Pop-Location }`,
      '  } finally {',
      '    Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue',
      '    foreach ($entry in $priorClaudeEnv) { [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value, "Process") }',
      '  }',
      '}'
    ].join('\n');
  }
  const quote = unixQuote;
  const command = [executable, ...args].map(quote).join(' ');
  if (platform === 'darwin') {
    const session = 'HOME="$HOME" USER="$login_user" LOGNAME="$login_user" TMPDIR="${TMPDIR:-/tmp}" __CF_USER_TEXT_ENCODING="${__CF_USER_TEXT_ENCODING:-}" LANG="${LANG:-}" TERM="${TERM:-dumb}"';
    return `(cd ${quote(directory)} && login_user=$(/usr/bin/id -un) && /usr/bin/env -i ${session} PATH="/usr/bin:/bin:/usr/sbin:/sbin" CLAUDE_CONFIG_DIR=${quote(directory)} ${command})`;
  }
  return `(cd ${quote(directory)} && /usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" LANG="$LANG" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TERM="$TERM" CLAUDE_CONFIG_DIR=${quote(directory)} ${command})`;
}

export function formatClaudeLoginCommand(executable, directory, platform = process.platform) {
  if (platform !== 'darwin') return formatClaudeTerminalCommand(executable, directory, loginArgs, platform);
  const login = formatClaudeTerminalCommand(executable, directory, ['--setting-sources=', 'auth', 'login'], platform);
  const status = formatClaudeTerminalCommand(executable, directory, ['--setting-sources=', 'auth', 'status', '--text'], platform);
  return `${login} && ${status}`;
}

export async function claudeTerminalInstructions(options = {}) {
  const result = await checkClaude(options);
  if (!result.ok && result.code !== 'CLAUDE_AUTH_REQUIRED') return result;
  try {
    const directory = await claudeProfilePath(options.profile ?? 'cli', defaultProfileRoot());
    return {
      ...result,
      terminal: process.platform === 'win32' ? 'PowerShell' : 'Terminal',
      login: formatClaudeLoginCommand(result.executable, directory),
      firstAnswer: formatClaudeTerminalCommand(result.executable, directory, answerArgs)
    };
  } catch (error) {
    const code = Object.hasOwn(messages, error.code) ? error.code : 'CLAUDE_PROTOCOL_ERROR';
    return { ...result, ok: false, code, message: messages[code] };
  }
}
