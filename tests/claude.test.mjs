import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { checkClaude, createClaudeChecker, formatClaudeLoginCommand, formatClaudeTerminalCommand } from '../packages/runtime/src/claude.mjs';

const executable = await realpath(process.execPath);
const profileRoot = await mkdtemp(path.join(tmpdir(), 'organis-claude-profile-test-'));
test.after(() => rm(profileRoot, { recursive: true, force: true }));
const versionResponse = { exitCode: 0, stdout: '2.1.316 (Claude Code)\n' };
const signedIn = { loggedIn: true, authMethod: 'claude.ai', email: 'ACCOUNT_MARKER', orgId: 'ORG_MARKER' };

function authResponse(options, data, exitCode = 0) {
  return { exitCode, stdout: JSON.stringify({ configDirectory: options.env.CLAUDE_CONFIG_DIR, ...data }) };
}

function withResponses(auth, version = versionResponse) {
  return createClaudeChecker({
    profileRoot,
    execute: async (_, args, options) => args[0] === '--version' ? version :
      typeof auth === 'function' ? auth(options) : auth
  });
}

test('Claude Code diagnostics only run discovery commands without inheriting credentials or exposing raw output', async () => {
  const calls = [];
  const check = createClaudeChecker({
    profileRoot,
    execute: async (file, args, { cwd, env, signal }) => {
      assert.equal(file, executable);
      assert.notEqual(cwd, process.cwd());
      assert.equal(signal.aborted, false);
      calls.push({ args, cwd, profile: env.CLAUDE_CONFIG_DIR });
      for (const key of Object.keys(env)) {
        assert.doesNotMatch(key, /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|NODE_OPTIONS|CODEX_HOME|ELECTRON_RUN_AS_NODE)$/i);
      }
      return args[0] === '--version' ? versionResponse : authResponse({ env }, signedIn);
    }
  });
  const result = await check({ executable });
  assert.equal(result.agent, 'claude');
  assert.equal(result.ok, true);
  assert.equal(result.version, '2.1.316');
  assert.deepEqual(result.authentication, { status: 'signed-in', kind: 'subscription' });
  assert.doesNotMatch(JSON.stringify(result), /ACCOUNT_MARKER|ORG_MARKER|CONFIG_MARKER/);
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['--setting-sources', '', 'auth', 'status', '--json']]);
  assert.equal(calls[0].cwd, calls[1].cwd);
  await assert.rejects(access(calls[0].cwd), { code: 'ENOENT' });
  await check({ executable, profile: 'desktop' });
  const root = await realpath(profileRoot);
  assert.deepEqual(calls.map(call => call.profile), ['cli', 'cli', 'desktop', 'desktop'].map(profile => path.join(root, profile)));
});

test('a reported signed-out status produces a distinct diagnostic with sign-in instructions', async () => {
  const check = withResponses(options => authResponse(options, { loggedIn: false, authMethod: 'none' }, 1));
  const result = await check({ executable });
  assert.equal(result.code, 'CLAUDE_AUTH_REQUIRED');
  assert.equal(result.ok, false);
  assert.deepEqual(result.authentication, { status: 'signed-out', kind: null });
  assert.match(result.message, /claude auth login/);
});

test('malformed, contradictory, and unknown Claude Code responses fail without exposing their content', async () => {
  for (const [auth, code] of [
    [{ exitCode: 1, stdout: 'SECRET_MARKER' }, 'CLAUDE_AUTH_CHECK_FAILED'],
    [{ exitCode: 9, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }, 'CLAUDE_AUTH_CHECK_FAILED'],
    [options => authResponse(options, signedIn, 1), 'CLAUDE_PROTOCOL_ERROR'],
    [options => authResponse(options, { ...signedIn, authMethod: 'SECRET_MARKER' }), 'CLAUDE_PROTOCOL_ERROR'],
    [options => authResponse(options, { ...signedIn, configDirectory: path.join(profileRoot, 'wrong') }), 'CLAUDE_PROFILE_UNVERIFIED'],
    [{ exitCode: 0, stdout: JSON.stringify(signedIn) }, 'CLAUDE_PROFILE_UNVERIFIED']
  ]) {
    const result = await withResponses(auth)({ executable });
    assert.equal(result.code, code);
    assert.equal(result.ok, false);
    assert.equal(result.authentication, null);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_MARKER/);
  }
  const wrongVersion = await withResponses(signedIn, { exitCode: 0, stdout: 'not Claude Code' })({ executable });
  assert.equal(wrongVersion.code, 'CLAUDE_VERSION_INVALID');
});

test('Claude Code checks distinguish explicit cancellation from timeout', async () => {
  const requests = [];
  const check = createClaudeChecker({ profileRoot, timeoutMs: 100, execute: async (_, args, { signal }) => {
    requests.push(args);
    signal.throwIfAborted();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  assert.equal((await check({ executable, signal: AbortSignal.abort() })).code, 'CLAUDE_CHECK_CANCELLED');
  assert.equal(requests.length, 0);
  assert.equal((await check({ executable })).code, 'CLAUDE_CHECK_TIMEOUT');
  assert.deepEqual(requests, [['--version']]);
});

test('native terminal instructions quote profile and executable paths for each shell', () => {
  const windows = formatClaudeTerminalCommand("C:\\Users\\O'Neil\\claude.exe", "C:\\Users\\O'Neil\\.organis\\claude\\desktop",
    ['--safe-mode', 'auth', 'login'], 'win32');
  assert.match(windows, /CLAUDE_CONFIG_DIR = 'C:\\Users\\O''Neil\\\.organis\\claude\\desktop'/);
  assert.match(windows, /& 'C:\\Users\\O''Neil\\claude\.exe' '--safe-mode' 'auth' 'login'/);
  assert.match(windows, /finally/);
  const curly = formatClaudeTerminalCommand('C:\\Users\\O’Brien\\claude.exe', 'C:\\profile',
    ['auth', 'login'], 'win32');
  assert.ok(curly.includes("'C:\\Users\\O’’Brien\\claude.exe'"));
  const mac = formatClaudeTerminalCommand("/Users/O'Neil/claude", "/Users/O'Neil/.organis/claude/cli",
    ['--tools=', '--print'], 'darwin');
  assert.ok(mac.includes("'/Users/O'\\''Neil/claude' '--tools=' '--print'"));
  assert.match(mac, /env -i/);
  assert.match(mac, /login_user=\$\(\/usr\/bin\/id -un\)/);
  assert.ok(mac.includes('TMPDIR="${TMPDIR:-/tmp}"'));
  assert.ok(mac.includes('__CF_USER_TEXT_ENCODING="${__CF_USER_TEXT_ENCODING:-}"'));
  assert.throws(() => formatClaudeTerminalCommand('/tmp/a\nb', '/tmp/profile', [], 'darwin'), { code: 'CLAUDE_EXECUTABLE_INVALID' });
});

test('macOS login checks the same native profile before reporting success', () => {
  const profile = '/Users/test/.organis/claude/desktop';
  const command = formatClaudeLoginCommand('/usr/local/bin/claude', profile, 'darwin');
  assert.equal(command.split(`CLAUDE_CONFIG_DIR='${profile}'`).length, 3);
  assert.match(command, /'--setting-sources=' 'auth' 'login'\) && \(cd /);
  assert.match(command, /'--setting-sources=' 'auth' 'status' '--text'\)$/);
});

test('the desktop panel displays native commands as text and clears them when the executable changes', async () => {
  const renderer = await readFile(new URL('../apps/desktop/claude-agents.js', import.meta.url), 'utf8');
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: true,
      addEventListener(event, listener) { this[event] = listener; }
    });
    return elements.get(selector);
  }
  const result = { executable, version: '2.1.316', message: 'Sign in', terminal: 'Terminal',
    login: '<official login>', firstAnswer: '<native answer>' };
  runInNewContext(renderer, {
    document: { querySelector: element },
    window: { organisAgents: {
      claudeTerminal: async () => result,
      chooseClaude: async () => '/new/claude'
    } }
  });
  await element('#claude-terminal').click();
  assert.equal(element('#claude-commands').hidden, false);
  assert.equal(element('#claude-login-command').value, result.login);
  assert.equal(element('#claude-answer-command').value, result.firstAnswer);
  await element('#choose-claude').click();
  assert.equal(element('#claude-commands').hidden, true);
});

test('Claude Code rejects relative paths, missing files, and Windows command shims', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'organis-claude-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await checkClaude({ executable: 'claude' })).code, 'CLAUDE_EXECUTABLE_INVALID');
  assert.equal((await checkClaude({ executable: path.join(root, 'missing-claude.exe') })).code, 'CLAUDE_EXECUTABLE_INVALID');
  if (process.platform === 'win32') {
    const shim = path.join(root, 'claude.cmd');
    await writeFile(shim, '@echo unable-to-run');
    assert.equal((await checkClaude({ executable: shim })).code, 'CLAUDE_SHIM_UNSUPPORTED');
  }
});

test('Claude Code CLI routes check, help and invalid usage without launching the provider', () => {
  const cli = fileURLToPath(new URL('../apps/cli/src/main.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, 'agent', 'claude', ...args], { encoding: 'utf8' });
  const help = run('check', '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /organis agent claude check/);
  assert.match(help.stdout, /organis agent claude terminal/);
  for (const args of [['login'], ['check', '--device-auth'], ['check', '--json', '--json']]) {
    const invalid = run(...args);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /INVALID_ARGUMENT/);
  }
  const invalidPath = run('check', '--executable', 'relative-path', '--json');
  assert.equal(invalidPath.status, 1);
  assert.equal(invalidPath.stderr, '');
  assert.equal(JSON.parse(invalidPath.stdout).code, 'CLAUDE_EXECUTABLE_INVALID');
});
