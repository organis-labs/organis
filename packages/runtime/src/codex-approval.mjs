import { supportsCodexVersion } from './agent-compatibility.mjs';

const methods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval'
]);
const permissionMethod = 'item/permissions/requestApproval';
export const isCodexApprovalMethod = method => methods.has(method);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const isRequestId = value => Number.isSafeInteger(value) || isIdentifier(value);
const MAX_TARGETS = 16;

// Preview strings are untrusted provider data. Reject imprecise paths and
// render control characters visibly in the live terminal/renderer.
function previewText(value, limit) {
  if (typeof value !== 'string' || !value) return undefined;
  return value.slice(0, limit).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    char => '\\u' + char.codePointAt(0).toString(16).padStart(4, '0'));
}

function previewPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return previewText(value, 1024);
}

export function describeCodexPatch(params) {
  if (!isIdentifier(params?.itemId) || !Array.isArray(params.changes)) return null;
  const changes = [];
  let incomplete = params.changes.length > MAX_TARGETS;
  for (const change of params.changes.slice(0, MAX_TARGETS)) {
    const path = previewPath(change?.path);
    const action = change?.kind?.type;
    const moveTo = previewPath(change?.kind?.move_path);
    const diff = previewText(change?.diff, 2048);
    if (!path || !['add', 'delete', 'update'].includes(action)) { incomplete = true; continue; }
    if (!diff || change.diff.length > 2048 || (change.kind.move_path != null && !moveTo)) incomplete = true;
    changes.push({ action, path, moveTo, diff });
  }
  return { itemId: params.itemId, changes, incomplete };
}

export function describeCodexApproval(method, params, patch) {
  if (method === 'item/fileChange/requestApproval') {
    const proposal = patch?.itemId === params.itemId ? patch : null;
    const requestedRoot = previewPath(params.grantRoot);
    return { kind: 'file-change', requestedRoot,
      changes: proposal?.changes ?? [], incomplete: !proposal || proposal.incomplete || (params.grantRoot != null && !requestedRoot) };
  }
  if (method === permissionMethod) {
    const fs = params.permissions.fileSystem;
    const paths = [];
    let incomplete = false;
    for (const access of ['read', 'write']) {
      const entries = fs?.[access];
      if (!Array.isArray(entries)) continue;
      for (const value of entries.slice(0, MAX_TARGETS)) {
        const path = previewPath(value);
        if (path && paths.length < MAX_TARGETS) paths.push({ access, path });
        else incomplete = true;
      }
      if (entries.length > MAX_TARGETS) incomplete = true;
    }
    const entries = Array.isArray(fs?.entries) ? fs.entries : [];
    for (const entry of entries.slice(0, MAX_TARGETS)) {
      const path = entry?.path?.type === 'path' ? previewPath(entry.path.path) : undefined;
      if (path && ['read', 'write', 'deny'].includes(entry.access) && paths.length < MAX_TARGETS) {
        paths.push({ access: entry.access, path });
      } else incomplete = true;
    }
    return { kind: 'permissions', cwd: previewPath(params.cwd), paths,
      networkRequested: params.permissions.network?.enabled === true,
      incomplete: incomplete || entries.length > MAX_TARGETS };
  }
  const stdin = params.kind === 'writeStdin';
  const command = stdin ? undefined : previewText(params.command, 2048);
  const cwd = previewPath(params.cwd);
  const actions = Array.isArray(params.commandActions) ? params.commandActions : [];
  const targets = actions.slice(0, MAX_TARGETS).flatMap(action => {
    const path = previewPath(action?.path);
    return path && ['read', 'listFiles', 'search'].includes(action.type) ? [{ action: action.type, path }] : [];
  });
  return { kind: stdin ? 'terminal-input' : 'command', cwd, command, targets,
    incomplete: !command || !cwd || params.command.length > 2048 || actions.length !== targets.length
      || params.additionalPermissions != null || params.networkApprovalContext != null
      || params.proposedExecpolicyAmendment != null || params.proposedNetworkPolicyAmendments != null };
}

// One intake per verified local connection and active turn. The coordinator supplies
// the binding out of band. Route only server requests here, separate from RPC
// responses and notifications. Stop the session without replying on a stop result.
export function createCodexApprovalIntake({ version, connectionId, threadId, turnId } = {}) {
  if (!supportsCodexVersion(version) || ![connectionId, threadId, turnId].every(isIdentifier)) {
    throw new TypeError('Codex approval intake requires a supported version and an active turn binding.');
  }
  const requests = new Set();
  let stopped = false;
  function stop(reason = 'closed') {
    stopped = true;
    requests.clear();
    return { disposition: 'stop', reason };
  }

  function handle(sourceConnectionId, message) {
    if (stopped) return stop();
    if (sourceConnectionId !== connectionId) return stop('connection-mismatch');
    if (!isObject(message) || !Object.hasOwn(message, 'id') || !isRequestId(message.id)
        || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')
        || Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) {
      return stop('invalid-request');
    }
    const { method, params, id } = message;
    if (!methods.has(method)) return stop('unsupported-request');
    if (!isObject(params) || !isIdentifier(params.itemId)
        || (!Number.isSafeInteger(params.startedAtMs) || params.startedAtMs < 0)
        || (params.approvalId != null && !isIdentifier(params.approvalId))
        || (method === permissionMethod && (!isIdentifier(params.cwd) || !isObject(params.permissions)))) {
      return stop('invalid-request');
    }
    if (params.threadId !== threadId || params.turnId !== turnId) return stop('turn-mismatch');
    if (params.environmentId != null) return stop('unsupported-environment');
    if (requests.has(id)) return stop('duplicate-request');
    if (requests.size >= 256) return stop('request-limit');
    requests.add(id);

    // Construct a fresh negative response
    // without copying requested permissions, amendments, commands or patches.
    const result = method === permissionMethod ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
    const response = message.jsonrpc === '2.0' ? { jsonrpc: '2.0', id, result } : { id, result };
    return { disposition: 'deny', response };
  }

  return { handle, close: () => { stop(); } };
}
