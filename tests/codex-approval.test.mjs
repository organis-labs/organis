import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexApprovalIntake } from '../packages/runtime/src/codex-approval.mjs';

const binding = { version: '0.164.0', connectionId: 'epoch-a', threadId: 'thread-a', turnId: 'turn-a' };
const command = 'item/commandExecution/requestApproval';
const file = 'item/fileChange/requestApproval';
const permissions = 'item/permissions/requestApproval';

function request(method = command, id = 1, params = {}) {
  return { method, id, params: { threadId: binding.threadId, turnId: binding.turnId, itemId: 'item-a', startedAtMs: 42, ...params } };
}

test('Codex approval intake declines action requests and grants no permissions', () => {
  const intake = createCodexApprovalIntake(binding);
  for (const [id, method, params, result] of [
    [0, command, { approvalId: 'sub-a', proposedExecpolicyAmendment: ['synthetic'] }, { decision: 'decline' }],
    ['0', command, { approvalId: 'sub-b' }, { decision: 'decline' }],
    [1, file, { grantRoot: '/synthetic' }, { decision: 'decline' }],
    [2, permissions, { cwd: '/synthetic', permissions: { network: { enabled: true } }, environmentId: null },
      { permissions: {}, scope: 'turn' }]
  ]) {
    assert.deepEqual(intake.handle(binding.connectionId, request(method, id, params)),
      { disposition: 'deny', response: { id, result } });
  }
  assert.deepEqual(intake.handle(binding.connectionId, { jsonrpc: '2.0', ...request(file, 3) }), {
    disposition: 'deny', response: { jsonrpc: '2.0', id: 3, result: { decision: 'decline' } }
  });
});

test('unsupported, malformed, or mismatched requests permanently stop their intake', () => {
  for (const [reason, message, source] of [
    ['connection-mismatch', request(), 'old-epoch'],
    ['turn-mismatch', request(command, 1, { threadId: 'wrong-thread' })],
    ['turn-mismatch', request(command, 1, { turnId: 'old-turn' })],
    ['unsupported-environment', request(command, 1, { environmentId: 'remote' })],
    ['unsupported-request', request('mcpServer/elicitation/request')],
    ['invalid-request', request(permissions)],
    ['invalid-request', request(command, null)],
    ['invalid-request', request(command, Number.MAX_SAFE_INTEGER + 1)],
    ['invalid-request', { ...request(), result: { decision: 'accept' } }]
  ]) {
    const intake = createCodexApprovalIntake(binding);
    assert.deepEqual(intake.handle(source ?? binding.connectionId, message), { disposition: 'stop', reason });
    assert.deepEqual(intake.handle(binding.connectionId, request()), { disposition: 'stop', reason: 'closed' });
  }
});

test('Codex intake rejects reused request ids, limits retained ids and honors closure', () => {
  const intake = createCodexApprovalIntake(binding);
  for (let id = 0; id < 256; id++) assert.equal(intake.handle(binding.connectionId, request(command, id)).disposition, 'deny');
  assert.deepEqual(intake.handle(binding.connectionId, request(command, 256)), { disposition: 'stop', reason: 'request-limit' });

  const next = createCodexApprovalIntake(binding);
  assert.equal(next.handle(binding.connectionId, request()).disposition, 'deny');
  assert.deepEqual(next.handle(binding.connectionId, request(file)), { disposition: 'stop', reason: 'duplicate-request' });
  const closed = createCodexApprovalIntake(binding);
  closed.close();
  assert.deepEqual(closed.handle(binding.connectionId, request()), { disposition: 'stop', reason: 'closed' });
  assert.throws(() => createCodexApprovalIntake({ ...binding, version: '0.167.0' }), TypeError);
  assert.throws(() => createCodexApprovalIntake({ ...binding, turnId: '' }), TypeError);
});
