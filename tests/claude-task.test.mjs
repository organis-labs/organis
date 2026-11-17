import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeTaskRunner, runClaude } from '../packages/runtime/src/claude.mjs';

const profileRoot = await mkdtemp(path.join(tmpdir(), 'organis-claude-task-test-'));
test.after(() => rm(profileRoot, { recursive: true, force: true }));
const executable = await realpath(process.execPath);
const planInput = { request: 'Replace START with END.', fileName: 'notes.txt' };
const planOutput = { summary: 'Update notes.', instructions: 'Replace START with END.', criteria: ['Keep the final newline.'] };

function success(runId, output, extras = {}) {
  return { exitCode: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    session_id: runId, structured_output: output, ...extras }) };
}

function runner(task, { authMethod = 'claude.ai', loggedIn = true, ...options } = {}) {
  return createClaudeTaskRunner({
    profileRoot, ...options,
    async execute(file, args, context) {
      assert.equal(file, executable);
      if (args[0] === '--version') return { exitCode: 0, stdout: '2.1.316 (Claude Code)\n' };
      if (args.includes('auth')) return { exitCode: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn, authMethod,
        configDirectory: context.env.CLAUDE_CONFIG_DIR, email: 'PRIVATE_ACCOUNT' }) };
      return task(args, context);
    }
  });
}

const taskData = input => JSON.parse(input.slice(input.indexOf('\n') + 1));

test('Claude plans using the signed-in desktop profile and only the projected request on stdin', async () => {
  const runId = randomUUID();
  let taskCwd;
  const run = runner(async (args, { cwd, env, input }) => {
    taskCwd = cwd;
    assert.notEqual(cwd, process.cwd());
    assert.equal(path.basename(env.CLAUDE_CONFIG_DIR), 'desktop');
    assert.match(cwd, /organis-claude-task-/);
    assert(!Object.keys(env).some(key => /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|NODE_OPTIONS|CODEX_HOME)$/i.test(key)));
    for (const flag of ['--safe-mode', '--setting-sources=', '--no-chrome', '--strict-mcp-config', '--tools=', '--no-session-persistence']) {
      assert(args.includes(flag));
    }
    assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--session-id') + 1], runId);
    assert.doesNotMatch(args.join(' '), /PRIVATE|START|notes.txt/);
    assert.deepEqual(taskData(input), planInput);
    return success(runId, planOutput, { result: 'PRIVATE_PROVIDER_ENVELOPE' });
  });
  assert.deepEqual(await run({ executable, runId, stage: 'plan', input: {
    ...planInput, transcript: 'PRIVATE_ROOM', workspace: 'PRIVATE_WORKSPACE', env: 'PRIVATE_ENV'
  } }), planOutput);
  await assert.rejects(access(taskCwd), { code: 'ENOENT' });
});

test('Claude reviews the selected original, replacement and recorded tests without forwarding other fields', async () => {
  const runId = randomUUID();
  const testRecord = { command: 'node --test notes.test.mjs', actor: 'User', exitCode: 0, result: 'Pass', revision: 'revision-1' };
  const input = { plan: { summary: planOutput.summary, criteria: planOutput.criteria },
    fileName: 'notes.txt', original: 'START\n', replacement: 'END\n', tests: [testRecord] };
  const run = runner(async (args, context) => {
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    assert.deepEqual(schema.properties.verdict.enum, ['passed', 'revision', 'failed']);
    assert.deepEqual(taskData(context.input), input);
    assert.match(context.input, /Do not run tools or claim tests ran if test records are missing/);
    return success(runId, { verdict: 'passed', summary: 'Both criteria met.' });
  });
  assert.deepEqual(await run({ executable, runId, stage: 'review', input: {
    ...input, rawConversation: 'PRIVATE_ROOM', plan: { ...planOutput, analysis: 'PRIVATE_ANALYSIS' },
    tests: [{ ...testRecord, rawLog: 'PRIVATE_LOG' }]
  } }), { verdict: 'passed', summary: 'Both criteria met.' });
});

test('Claude refuses invalid or oversize data and checks subscription authentication before starting a task', async () => {
  const task = () => assert.fail('Should not start a Claude task');
  const runId = randomUUID();
  const run = runner(task);
  const args = { executable, runId, stage: 'plan' };
  for (const input of [{ ...planInput, fileName: '../notes.txt' }, { ...planInput, request: '가'.repeat(1400) }]) {
    await assert.rejects(run({ ...args, input }), { code: 'CLAUDE_TASK_INVALID' });
  }
  await assert.rejects(runner(task, { loggedIn: false, authMethod: 'none' })({ ...args, input: planInput }),
    { code: 'CLAUDE_AUTH_REQUIRED' });
  await assert.rejects(runner(task, { authMethod: 'api_key' })({ ...args, input: planInput }),
    { code: 'CLAUDE_TASK_AUTH_REQUIRED' });
});

test('Claude rejects mismatched or malformed structured results and omits raw provider output from errors', async () => {
  const runId = randomUUID();
  for (const [result, code] of [
    [success(randomUUID(), planOutput), 'CLAUDE_PROTOCOL_ERROR'],
    [success(runId, planOutput, { permission_denials: [{ tool: 'Read' }] }), 'CLAUDE_PROTOCOL_ERROR'],
    [success(runId, { ...planOutput, criteria: ['x'.repeat(513)] }), 'CLAUDE_PROTOCOL_ERROR'],
    [success(runId, { ...planOutput, extra: 'PRIVATE_MARKER' }), 'CLAUDE_PROTOCOL_ERROR'],
    [{ exitCode: 1, stdout: 'PRIVATE_MARKER' }, 'CLAUDE_TASK_FAILED']
  ]) {
    await assert.rejects(runner(async () => result)({ executable, runId, stage: 'plan', input: planInput }), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /PRIVATE_MARKER/);
      return true;
    });
  }
});

test('explicit cancellation waits for the runner to finish before releasing its scratch directory', async () => {
  const started = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const abort = new AbortController();
  const run = runner(async (_, { cwd, signal }) => {
    signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    started.resolve(cwd);
    await exited.promise;
    signal.throwIfAborted();
  });
  const pending = run({ executable, runId: randomUUID(), stage: 'plan', input: planInput, signal: abort.signal });
  const done = assert.rejects(pending, { code: 'CLAUDE_TASK_CANCELLED' });
  const cwd = await started.promise;
  abort.abort();
  await cancelled.promise;
  await access(cwd);
  exited.resolve();
  await done;
  await assert.rejects(access(cwd), { code: 'ENOENT' });
});

test('execution stops if a native child PID cannot be journaled', async () => {
  let pid;
  await assert.rejects(runClaude(executable, ['-e', 'process.stdin.resume(); setTimeout(() => {}, 15000)'], {
    signal: new AbortController().signal, input: 'not sent',
    onSpawn(childPid) { pid = childPid; throw new Error('State storage unavailable'); }
  }), { code: 'CLAUDE_START_FAILED' });
  assert(Number.isInteger(pid));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
