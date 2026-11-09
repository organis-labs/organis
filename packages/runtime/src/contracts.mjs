// Frozen local-execution contracts (M1). Electron-independent.

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

export const SCHEMA_VERSION = 1;

export const RUN_STATES = freeze(['queued', 'running', 'awaiting_approval', 'cancelling',
  'completed', 'failed', 'cancelled', 'interrupted']);
export const LIVE_STATES = freeze(['queued', 'running', 'awaiting_approval', 'cancelling']);
export const TERMINAL_STATES = freeze(['completed', 'failed', 'cancelled', 'interrupted']);
// awaiting_approval is contract-only: no M1 code path enters it.
export const IMPLEMENTED_STATES = freeze(RUN_STATES.filter(state => state !== 'awaiting_approval'));

export const TRANSITIONS = freeze({
  queued: ['running', 'cancelling', 'cancelled', 'failed', 'interrupted'],
  running: ['awaiting_approval', 'completed', 'failed', 'cancelling', 'interrupted'],
  awaiting_approval: ['running', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: []
});

export const APPROVAL_STATES = freeze(['not_required', 'pending', 'approved', 'rejected', 'expired']);

export const APPROVAL_IDENTITY_CONTRACT = freeze({
  implemented: 'contract-only',
  fields: {
    approvalId: 'Durable UUID of the approval request.',
    runId: 'Run the approval applies to.',
    attemptId: 'Attempt the approval applies to; an approval never carries over to another attempt.',
    scope: 'Exact scope that was requested. It is never broadened by the approver or by the runtime.',
    actionDigest: 'Digest of the exact action; changed payloads invalidate approval.',
    actionRevision: 'Owner revision checked when applying the decision.',
    expiresAt: 'Expiry checked on the owning host, including after reconnect.',
    grantId: 'Exact permission grant authorizing the decision.',
    principalId: 'Authenticated deciding principal; participant labels are not authority.',
    requestedBy: 'participantId that requested the approval.',
    decidedBy: 'participantId that decided; must differ from requestedBy.',
    commandId: 'Idempotency key of the deciding command.',
    decidedAt: 'ISO-8601 time of the decision.'
  },
  limitations: [
    'No M1 code path creates or decides approvals; runs always report approvalState not_required.',
    'Participant identity is a client-supplied UUID, not an authenticated principal.',
    'Approvals for real agent execution are specified before, not implemented in, M1.'
  ]
});

export const FIXTURE_CAPABILITY = freeze({
  id: 'organis.fixture',
  scope: 'trusted-workspace',
  sandbox: false,
  networkIsolation: false,
  filesystemIsolation: false,
  modes: ['complete', 'fail', 'wait'],
  maxDurationMs: 30000
});

const contract = (implemented, fields, limitation) => ({ implemented, fields, limitation });

export const ENTITY_CONTRACTS = freeze({
  room: contract('contract-only',
    ['roomId', 'title', 'ownerHostId', 'createdAt'],
    'Only a client-supplied roomId label is stored on runs; there is no room table or membership.'),
  participant: contract('contract-only',
    ['participantId', 'roomId', 'role', 'agentCapabilityId', 'providerSessionRef'],
    'A participant is a room-local role with a provider session reference; only a participantId label is stored on runs.'),
  message: contract('contract-only',
    ['messageId', 'roomId', 'participantId', 'sequence', 'commandId', 'body', 'createdAt'],
    'Messages are separate from execution events. sequence is per room; execution events use a separate global sequence.'),
  workspace: contract('m1-fixture',
    ['key', 'fileId', 'path', 'busyRunId'],
    'Canonical directory with a single live writer. A worktree is not a sandbox.'),
  task: contract('m1-fixture',
    ['taskId', 'roomId', 'participantId', 'commandId'],
    'One task is created per accepted fixture command; there is no assignment or multi-attempt scheduling.'),
  run: contract('m1-fixture',
    ['id', 'taskId', 'attemptId', 'state', 'approvalState', 'ownerId', 'processPid', 'exitCode', 'errorCode', 'ownershipRetained'],
    'Runs launch only the bundled deterministic fixture.'),
  attempt: contract('m1-fixture',
    ['attemptId', 'taskId', 'runId'],
    'Exactly one attempt per run; the runtime never replays or retries an attempt.'),
  event: contract('m1-fixture',
    ['sequence', 'runId', 'type', 'at', 'data'],
    'Globally monotonic sequence; used as an exclusive resume cursor. Not a chat message.'),
  agentCapability: contract('m1-fixture',
    ['id', 'scope', 'sandbox', 'networkIsolation', 'filesystemIsolation', 'modes', 'maxDurationMs'],
    'Only the organis.fixture capability exists; no real agent tool is registered.'),
  host: contract('contract-only',
    ['hostId', 'platform', 'arch', 'ownerId'],
    'Execution host registration and remote hosts are not implemented; ownerId identifies a local owner process.'),
  artifact: contract('contract-only',
    ['artifactId', 'runId', 'kind', 'uri', 'digest'],
    'Run outputs are not captured or stored in M1.'),
  approval: contract('contract-only',
    Object.keys(APPROVAL_IDENTITY_CONTRACT.fields),
    'See APPROVAL_IDENTITY_CONTRACT. awaiting_approval is never entered.')
});

// retryable: a client may submit a NEW command; the runtime never replays.
export const ERROR_CODES = freeze({
  INVALID_ARGUMENT: { retryable: false },
  INVALID_WORKSPACE: { retryable: false },
  SCOPE_DENIED: { retryable: false },
  SANDBOX_UNSUPPORTED: { retryable: false },
  COMMAND_CONFLICT: { retryable: false },
  INVALID_TRANSITION: { retryable: false },
  RUN_NOT_FOUND: { retryable: false },
  SCHEMA_TOO_NEW: { retryable: false },
  WORKSPACE_BUSY: { retryable: true },
  PERSISTENCE_FAILED: { retryable: true },
  RUNTIME_CLOSED: { retryable: true },
  WAIT_TIMEOUT: { retryable: true },
  SPAWN_FAILED: { retryable: true },
  FIXTURE_FAILED: { retryable: true },
  ENV_LEAK: { retryable: false },
  CANCEL_UNVERIFIED: { retryable: false },
  TERMINATION_UNVERIFIED: { retryable: false },
  OWNER_LOST: { retryable: true }
});

export class RuntimeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'RuntimeError';
    this.code = code;
    this.retryable = ERROR_CODES[code]?.retryable ?? false;
  }
}

export function assertTransition(from, to) {
  if (!Object.hasOwn(TRANSITIONS, from) || !TRANSITIONS[from].includes(to)) {
    throw new RuntimeError('INVALID_TRANSITION', `Invalid run transition ${from} -> ${to}.`);
  }
}
