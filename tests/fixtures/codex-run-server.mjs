
import { createInterface } from 'node:readline';

const [scenario, operation] = process.argv.slice(2);
if (operation === '--version') {
  console.log(scenario.startsWith('model-') ? 'codex-cli 0.171.0' : 'codex-cli 0.164.0');
} else {
  const threadId = 'fixture-thread';
  const turnId = 'fixture-turn';
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  const notify = (method, params) => send({ method, params });
  const done = status => notify('turn/completed', { threadId, turn: { id: turnId, status } });
  const input = createInterface({ input: process.stdin });
  let openedThread = false;
  function requestApproval() {
    const permission = scenario === 'approval-permissions';
    const file = scenario.startsWith('approval-file');
    if (file) notify('item/fileChange/patchUpdated', {
      threadId, turnId, itemId: scenario === 'approval-file' ? 'mock-item' : 'other-item',
      changes: [{ path: 'notes.txt', kind: { type: 'add' }, diff: '+private-patch-marker' }]
    });
    send({
      id: 'approve', method: permission ? 'item/permissions/requestApproval' :
        file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
      params: { threadId, turnId, itemId: 'mock-item', startedAtMs: 1, command: 'private-command-marker',
        ...(permission ? { cwd: process.cwd(), permissions: { network: { enabled: true } } } : {}) }
    });
  }
  input.on('line', line => {
    const { method, id, params, result } = JSON.parse(line);
    if (id === 'approve') {
      const want = scenario === 'approval-permissions' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
      if (JSON.stringify(result) !== JSON.stringify(want)) process.exit(88);
      done('completed');
      return;
    }
    const reply = result => send({ id, result });
    switch (method) {
      case 'initialize': reply({ userAgent: 'fixture' }); break;
      case 'account/read': reply({ account: { type: 'chatgpt', email: 'private-email-marker' } }); break;
      case 'windowsSandbox/readiness': reply({ status: scenario === 'no-sandbox' ? 'notConfigured' : 'ready' }); break;
      case 'configRequirements/read': reply({ requirements: scenario === 'managed-tool'
        ? { featureRequirements: { shell_tool: true } } : null }); break;
      case 'model/list':
        if (!scenario.startsWith('model-')) process.exit(94);
        reply(params.cursor ? { data: [{ model: 'fixture-model' }], nextCursor: null } :
          { data: [], nextCursor: scenario === 'model-missing' ? null : 'next' });
        break;
      case 'config/read': {
        const mcp = scenario === 'mcp' || (scenario === 'mcp-appeared' && openedThread);
        reply({ config: mcp ? { mcp_servers: { fixture: { command: 'never-start-this' } } } : {} });
        break;
      }
      case 'thread/start':
        if (params.cwd !== process.cwd() || params.sandbox !== 'read-only'
            || params.approvalPolicy !== 'never' || scenario === 'mcp' || scenario === 'managed-tool') process.exit(89);
        if (scenario === 'model-missing' || (scenario === 'model-selected' && params.model !== 'fixture-model')) process.exit(95);
        openedThread = true;
        reply({ thread: { id: threadId, ephemeral: true }, cwd: process.cwd(), modelProvider: 'openai',
          sandbox: { type: scenario === 'policy' ? 'workspaceWrite' : 'readOnly', networkAccess: false },
          approvalPolicy: 'never', approvalsReviewer: 'user', model: params.model });
        break;
      case 'turn/start':
        if (['policy', 'mcp-appeared'].includes(scenario) || params.threadId !== threadId || params.sandboxPolicy) process.exit(90);
        if (scenario === 'complete' || scenario === 'model-selected') {
          // App-server notifications may arrive before the corresponding RPC reply.
          notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', text: 'SYNTHETIC_ANSWER' } });
          done('completed');
        }
        if (scenario === 'desktop-file-change' && !params.input?.[0]?.text.includes('Wait for explicit cancellation')) {
          if (!params.input?.[0]?.text.includes('Original fixture content')
              || params.outputSchema?.properties?.replacement?.type !== 'string'
              || params.outputSchema.additionalProperties !== false) process.exit(93);
          notify('item/completed', { threadId, turnId, item: { type: 'agentMessage',
            text: JSON.stringify({ replacement: 'Updated fixture content\n' }) } });
          done('completed');
        }
        if (['approval-early', 'approval-ended'].includes(scenario)) requestApproval();
        reply({ turn: { id: turnId, status: 'inProgress' } });
        if (scenario === 'option-like-prompt') done(params.input?.[0]?.text === '--help' ? 'completed' : 'failed');
        if (scenario === 'failure') done('failed');
        if (['approval', 'approval-permissions', 'approval-delivery-failure', 'approval-file', 'approval-file-mismatch'].includes(scenario)) requestApproval();
        if (scenario === 'approval-ended') done('completed');
        if (scenario === 'unsafe') notify('item/started', { threadId, turnId, item: { type: 'commandExecution' } });
        if (scenario === 'unexpected-request') setTimeout(() => send({
          id: 'unexpected', method: 'mcpServer/elicitation/request', params: { threadId, turnId }
        }), 100);
        break;
      case 'turn/interrupt':
        if (params.threadId !== threadId || params.turnId !== turnId) process.exit(91);
        reply({});
        if (scenario !== 'unconfirmed') done('interrupted');
        break;
      case 'thread/unsubscribe': reply({ status: 'unsubscribed' }); break;
      case 'initialized': break;
      default: process.exit(92);
    }
  });
}
