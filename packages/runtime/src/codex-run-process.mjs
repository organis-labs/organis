
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CodexConnection, codexEnvironment, codexFault, resolveCodex, testedCodexVersions } from './codex.mjs';
import { createCodexApprovalIntake, describeCodexApproval, describeCodexPatch } from './codex-approval.mjs';
import { fileChangeSchema } from './codex-file-change.mjs';
import { prepareCodexProfile } from './codex-profile.mjs';
import { ProjectRegistry } from './projects.mjs';

const disabledFeatures = [
  'apps', 'plugins', 'hooks', 'multi_agent', 'multi_agent_v2', 'daemon_auto_start',
  'shell_tool', 'shell_snapshot', 'unified_exec', 'code_mode', 'code_mode_host',
  'skill_mcp_dependency_install', 'image_generation', 'view_image', 'remote_control'
];
const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const policyError = () => codexFault('CODEX_POLICY_UNVERIFIED');
const protocolError = () => codexFault('CODEX_PROTOCOL_ERROR');

async function run({ executable, prompt, fileId, durationMs, projectId, stateDir, profile, fileChange }, { report, signal }) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(codexFault('CODEX_RUN_TIMEOUT')), durationMs);
  let connection;
  let threadId;
  let turnId;
  let intake;
  let approval;
  let patch;
  let answer = '';
  let ready = false;
  let mayHaveStartedTurn = false;
  let turnReported = false;
  let turnFinished = false;
  let unexpectedTool = false;
  let complete;
  const completed = new Promise(resolve => { complete = resolve; });
  const pending = [];
  let code;
  let interruptUnconfirmed = false;
  let cancelBeforeTurnId;
  let cancelDeadline;
  const cwd = process.cwd();
  let providerEnv;
  const cancel = () => {
    cancelDeadline = Date.now() + 2500;
    if (!mayHaveStartedTurn) abort.abort(codexFault('CODEX_CHECK_CANCELLED'));
    else if (!turnId) {
      cancelBeforeTurnId = setTimeout(() => abort.abort(codexFault('CODEX_CHECK_CANCELLED')), 2500);
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  process.on('message', denyApproval);
  if (signal.aborted) cancel();
  try {
    abort.signal.throwIfAborted();
    const selected = await resolveCodex({ executable });
    const { env, args: profileArgs } = await prepareCodexProfile(profile, codexEnvironment());
    providerEnv = env;
    connection = start(selected, ['--version']);
    const output = await connection.version();
    await connection.close();
    connection = null;
    const version = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(output)?.[1];
    if (!testedCodexVersions.includes(version)) throw codexFault('CODEX_VERSION_UNSUPPORTED');

    verifyWorkspace();
    connection = start(selected, ['app-server', '--stdio', '--strict-config',
      ...disabledFeatures.flatMap(feature => ['--disable', feature]),
      '--enable', 'skip_host_skill_discovery', '-c', 'web_search="disabled"',
      '-c', 'project_doc_max_bytes=0', '-c', 'allow_login_shell=false',
      '-c', 'model_provider="openai"', '-c', 'analytics.enabled=false', ...profileArgs], onMessage);
    if (connection.child.pid) {
      // Do not act on the workspace until the owner has persisted the process identity.
      ready = await report({ type: 'ready', grandchildPid: connection.child.pid }, true);
      if (!ready) throw codexFault('CODEX_CHECK_CANCELLED');
    }
    try {
      await connection.request('initialize', {
        clientInfo: { name: 'organis_read_only', version: '0.1.0' },
        capabilities: { experimentalApi: false }
      });
    } catch (error) {
      if (connection.ended && connection.exitCode !== 0 && !connection.error) throw codexFault('CODEX_START_FAILED');
      throw error;
    }
    connection.notify('initialized');
    const account = await connection.request('account/read', { refreshToken: false });
    if (!(profile ? ['chatgpt'] : ['chatgpt', 'apiKey']).includes(account?.account?.type)) throw codexFault('CODEX_AUTH_REQUIRED');
    if (process.platform === 'win32') {
      const readiness = await connection.request('windowsSandbox/readiness', {});
      if (readiness?.status !== 'ready') throw codexFault('CODEX_SANDBOX_REQUIRED');
    }

    const { requirements } = await connection.request('configRequirements/read', {});
    if (requirements !== null && (!requirements || typeof requirements !== 'object' || Array.isArray(requirements))) {
      throw policyError();
    }
    if (disabledFeatures.some(feature => requirements?.featureRequirements?.[feature] === true)) throw policyError();
    if (await hasConfiguredServers()) throw codexFault('CODEX_MCP_UNSUPPORTED');
    await verifyRegistration();
    const thread = await connection.request('thread/start', {
      cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
      modelProvider: 'openai'
    });
    if (!isId(thread?.thread?.id) || thread.thread.ephemeral !== true || !matchesWorkspace(thread.cwd)
        || thread.sandbox?.type !== 'readOnly' || thread.sandbox.networkAccess !== false
        || thread.approvalPolicy !== 'never' || thread.approvalsReviewer !== 'user'
        || thread.modelProvider !== 'openai') throw policyError();
    threadId = thread.thread.id;
    if (await hasConfiguredServers().catch(() => true)) {
      markUncertain();
      throw policyError();
    }

    abort.signal.throwIfAborted();
    await verifyRegistration();
    abort.signal.throwIfAborted();
    mayHaveStartedTurn = true;
    const started = await connection.request('turn/start', {
      threadId, input: [{ type: 'text', text: prompt, text_elements: [] }],
      ...(fileChange ? { outputSchema: fileChangeSchema } : {})
    });
    if (!isId(started?.turn?.id)) throw protocolError();
    turnId = started.turn.id;
    clearTimeout(cancelBeforeTurnId);
    intake = createCodexApprovalIntake({ version, connectionId: threadId, threadId, turnId });
    if (!await report({ type: 'turn', threadId, turnId, version })) throw protocolError();
    turnReported = true;
    for (const message of pending) onMessage(message);
    pending.length = 0;
    const event = await waitForTurn();
    interruptUnconfirmed = event.status === 'interrupt-unconfirmed';
    if (event.status !== 'completed') code = 'CODEX_RUN_FAILED';

    async function waitForTurn() {
      let interrupt;
      let cancelTimer;
      const interruptTurn = () => {
        if (interrupt) return;
        const cutoff = new Promise(resolve => {
          cancelTimer = setTimeout(() => resolve({ status: 'interrupt-unconfirmed' }), Math.max(0, cancelDeadline - Date.now()));
        });
        interrupt = Promise.race([
          connection.request('turn/interrupt', { threadId, turnId })
            .then(() => completed).catch(() => ({ status: 'interrupt-unconfirmed' })),
          cutoff
        ]).then(complete);
      };
      signal.addEventListener('abort', interruptTurn, { once: true });
      if (signal.aborted) interruptTurn();
      try {
        const terminal = await Promise.race([completed, connection.failed.then(() => null), connection.closed.then(() => null)]);
        if (!terminal) throw connection.error ?? protocolError();
        return terminal;
      } finally {
        signal.removeEventListener('abort', interruptTurn);
        clearTimeout(cancelTimer);
      }
    }
  } catch (error) {
    interruptUnconfirmed = signal.aborted && mayHaveStartedTurn;
    code = typeof error?.code === 'string' && error.code.startsWith('CODEX_') ? error.code : 'CODEX_RUN_FAILED';
  } finally {
    clearTimeout(timeout);
    clearTimeout(cancelBeforeTurnId);
    signal.removeEventListener('abort', cancel);
    process.off('message', denyApproval);
    intake?.close();
    try {
      await connection?.close();
      if (!code && connection?.error) code = connection.error.code;
    } catch {
      if (!code || !connection.ended) code = 'CODEX_EXIT_FAILED';
    }
    if (!ready && (!connection?.child.pid || connection.ended)) await report({ type: 'ready', grandchildPid: null });
  }
  return {
    ok: !code, code, answer: !code && answer ? answer : undefined, unexpectedTool, interruptUnconfirmed,
    processClosed: !connection || connection.ended === true
  };

  function start(selected, args, onMessage) {
    abort.signal.throwIfAborted();
    const child = spawn(selected, args, {
      cwd, env: providerEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    return new CodexConnection(child, abort.signal, 1500, onMessage);
  }

  function verifyWorkspace() {
    const folder = statSync(cwd, { bigint: true });
    if (!folder.isDirectory() || fileId !== String(folder.dev) + ':' + String(folder.ino)) throw policyError();
  }

  async function verifyRegistration() {
    const registry = new ProjectRegistry(stateDir);
    try {
      const registration = await registry.codexTarget(projectId);
      if (registration.fileId !== fileId || !matchesWorkspace(registration.workspace)) throw policyError();
      verifyWorkspace();
    } catch {
      throw policyError();
    } finally {
      registry.close();
    }
  }

  function matchesWorkspace(reported) {
    try {
      return typeof reported === 'string' && path.isAbsolute(reported)
        && realpathSync.native(reported) === realpathSync.native(cwd);
    } catch {
      return false;
    }
  }

  // config/read reads settings without starting MCP servers, unlike a status
  // probe that connects to configured servers to discover their capabilities.
  async function hasConfiguredServers() {
    const { config } = await connection.request('config/read', { cwd, includeLayers: false });
    const table = config?.mcp_servers ?? {};
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || typeof table !== 'object' || Array.isArray(table)) throw policyError();
    return Object.keys(table).length > 0;
  }

  function onMessage(message) {
    const { method, params } = message;
    if (mayHaveStartedTurn && !turnReported) { pending.push(message); return; }
    if (message.id !== undefined) {
      const decision = intake?.handle(threadId, message);
      if (decision?.disposition !== 'deny' || approval || turnFinished) {
        markUncertain();
        throw protocolError();
      }
      if (signal.aborted) return;
      approval = { id: randomUUID(), response: decision.response };
      // Only the owner's persisted denial can release this response. Cancellation
      // interrupts the turn if the owner stopped accepting approval requests.
      const preview = describeCodexApproval(method, params, patch);
      patch = undefined;
      void report({ type: 'approval', approvalId: approval.id, method, preview }).then(sent => {
        if (!sent && !signal.aborted) connection.fail(protocolError());
      });
      return;
    }
    if (method === 'item/fileChange/patchUpdated') {
      if (threadId && turnId && !approval && !turnFinished && params?.threadId === threadId && params.turnId === turnId) {
        patch = describeCodexPatch(params);
      }
      return;
    }
    if (method !== 'turn/completed' && method !== 'item/started' && method !== 'item/completed') return;
    if (params?.threadId !== threadId || !threadId || !mayHaveStartedTurn) return;
    if (method === 'turn/completed') {
      if (params.turn?.id === turnId) {
        turnFinished = true;
        complete(approval ? { status: 'approval-unanswered' } : params.turn);
      }
    } else if (params.turnId === turnId) {
      const item = params.item;
      if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(item?.type)) {
        markUncertain();
        throw policyError();
      }
      if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
        answer = item.text.slice(0, 32768);
      }
    }
  }

  function denyApproval(message) {
    if (message?.type !== 'deny-approval' || !approval || message.approvalId !== approval.id || signal.aborted) return;
    const { response } = approval;
    approval = undefined;
    try { connection.send(response); }
    catch { connection.fail(protocolError()); }
  }

  function markUncertain() {
    if (unexpectedTool) return;
    unexpectedTool = true;
    void report({ type: 'unsafe' });
  }
}

const cancel = new AbortController();
const report = (message, waitForAck = false) => new Promise(resolve => {
  if (!process.connected) return resolve(false);
  if (waitForAck) {
    const ack = value => { if (value?.type === 'launch-confirmed') finish(true); };
    const finish = result => {
      process.off('message', ack);
      cancel.signal.removeEventListener('abort', stopped);
      resolve(result);
    };
    const stopped = () => finish(false);
    process.on('message', ack);
    if (cancel.signal.aborted) return stopped();
    cancel.signal.addEventListener('abort', stopped, { once: true });
    process.send(message, error => { if (error) finish(false); });
  } else process.send(message, error => resolve(!error));
});
process.on('SIGINT', () => {});
process.on('disconnect', () => cancel.abort());
process.on('message', async message => {
  if (message?.type === 'cancel') cancel.abort();
  if (message?.type !== 'start') return;
  const result = await run(message, { report, signal: cancel.signal });
  await report({ type: 'result', ...result });
  if (process.connected) process.disconnect();
  process.exitCode = result.ok ? 0 : 1;
});
