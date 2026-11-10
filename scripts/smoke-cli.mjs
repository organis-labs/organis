import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function smokeCLI(executable, entry, { earlyInterrupt = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'organis-cli-smoke-'));
  const workspace = join(root, 'workspace with spaces');
  mkdirSync(workspace);
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.ELECTRON_RUN_AS_NODE;
  const invoke = (args, expected = 0) => {
    const result = spawnSync(executable, [entry, 'run', ...args, '--state-dir', join(root, 'state'), '--json'], {
      env, encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    if (result.error || result.status !== expected) throw new Error(`CLI execution smoke failed: ${result.error?.message ?? result.stderr} ${result.stdout}`);
    return result.stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  try {
    const connection = spawnSync(executable, [entry, 'agent', 'codex', 'check', '--executable', join(root, 'codex-missing'), '--json'],
      { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (connection.error || connection.status !== 1 || connection.stderr !== '') throw new Error('CLI connection diagnostic failed');
    const diagnostic = JSON.parse(connection.stdout);
    if (diagnostic.code !== 'CODEX_EXECUTABLE_INVALID' || diagnostic.capabilities.taskExecution !== false) throw new Error('CLI hid a missing Codex installation');
    const project = args => {
      const result = spawnSync(executable, [entry, 'project', ...args, '--state-dir', join(root, 'state'), '--json'],
        { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`CLI project smoke failed: ${result.error?.message ?? result.stderr}`);
      return JSON.parse(result.stdout);
    };
    const { project: { id: projectId } } = project(['add', workspace]);
    project(['set-path', projectId, workspace, '--access', 'deny']);
    const preview = project(['show', projectId]);
    if (preview.effective !== null || preview.executionAvailable || preview.paths[0]?.access !== 'deny') {
      throw new Error('CLI did not preserve requested access separately from enforcement');
    }
    const commandId = randomUUID();
    const request = ['fixture', '--workspace', workspace, '--command-id', commandId];
    const first = invoke(request);
    if (first[0].type !== 'accepted' || first.at(-1).run.state !== 'completed') throw new Error('CLI did not complete fixture');
    const run = first.at(-1).run;
    const repeated = invoke(request);
    if (!repeated[0].duplicate || repeated.at(-1).run.id !== run.id) throw new Error('CLI repeated a command');
    if (invoke(['show', run.id])[0].run.state !== 'completed') throw new Error('CLI lost persisted state');
    if (!invoke(['events', run.id])[0].events.length) throw new Error('CLI lost persisted events');
    const failed = invoke(['fixture', '--workspace', workspace, '--mode', 'fail'], 1);
    if (failed.at(-1).run.state !== 'failed') throw new Error('CLI hid fixture failure');
    const refused = spawnSync(executable, [entry, 'run', 'fixture', '--workspace', workspace, '--scope', 'os-sandbox',
      '--state-dir', join(root, 'state'), '--json'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (refused.status !== 1 || refused.stdout !== '') throw new Error('Packaged CLI accepted unsupported scope');
    const child = spawn(executable, [entry, 'run', 'fixture', '--workspace', workspace, '--mode', 'wait',
      '--state-dir', join(root, 'state'), '--json'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const closed = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
    let timer;
    try {
      if (earlyInterrupt) child.send({ type: 'organis:interrupt' });
      const deadline = Date.now() + 10000;
      while (!stdout.includes('\n') && child.exitCode === null && Date.now() < deadline) await delay(25);
      if (!stdout.includes('\n')) throw new Error(`CLI did not acknowledge wait fixture: ${stderr}`);
      // Same private control message used by the standalone launcher's Ctrl+C handler.
      if (!earlyInterrupt) child.send({ type: 'organis:interrupt' });
      const code = await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CLI cancellation timed out')), 15000);
      })]);
      if (code !== 130 || JSON.parse(stdout.trim().split('\n').at(-1)).run.state !== 'cancelled') {
        throw new Error(`CLI did not drain cancellation: ${stdout} ${stderr}`);
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      await closed.catch(() => {});
    }
    return { completion: true, persistence: true, deduplication: true, failure: true, cancellation: true, deniedScope: true, headless: true, codexConnectionDiagnostic: true };
  } finally {
    // root is a fresh OS temporary directory created by this invocation only.
    rmSync(root, { recursive: true, force: true });
  }
}
