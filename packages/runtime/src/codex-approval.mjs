const methods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval'
]);
const permissionMethod = 'item/permissions/requestApproval';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const isRequestId = value => Number.isSafeInteger(value) || isIdentifier(value);

// One intake per verified local connection and active turn. The coordinator supplies
// the binding out of band. The transport must stop the session on a stop result.
export function createCodexApprovalIntake({ version, connectionId, threadId, turnId } = {}) {
  if (version !== '0.164.0' || ![connectionId, threadId, turnId].every(isIdentifier)) {
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

    // No approval authority is wired. Construct a fresh negative response
    // without copying requested permissions, amendments, commands or patches.
    const result = method === permissionMethod ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
    const response = message.jsonrpc === '2.0' ? { jsonrpc: '2.0', id, result } : { id, result };
    return { disposition: 'deny', response };
  }

  return { handle, close: () => { stop(); } };
}
