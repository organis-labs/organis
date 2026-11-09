import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const [mode, record, ...args] = process.argv.slice(2);
if (args[0] === '--version') {
  if (mode === 'version-timeout') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (mode === 'version-failed') process.exit(3);
  console.log(mode === 'unsupported' ? 'codex-cli 0.165.0' : 'codex-cli 0.164.0');
  process.exit(0);
}
const requests = [];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin });
if (mode === 'timeout') setInterval(() => {}, 1000);
input.on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) return;
  requests.push(message.method);
  if (record !== '-') writeFileSync(record, JSON.stringify({ requests, args, envNames: Object.keys(process.env) }));
  if (mode === 'timeout') return;
  if (mode === 'malformed') { process.stdout.write('not-json\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(1024 * 1024 + 1)); return; }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'test' } });
    send({ id: 'unexpected', method: 'item/commandExecution/requestApproval', params: { command: 'must not execute' } });
  }
  if (message.method === 'account/read') {
    if (mode === 'rpc-error') send({ id: message.id, error: { code: -1, message: 'PRIVATE_ERROR_SECRET' } });
    else send({ id: message.id, result: { requiresOpenaiAuth: true, account: mode === 'signed-out' ? null
      : { type: mode === 'unknown-auth' ? 'future' : 'chatgpt', email: 'PRIVATE_ACCOUNT_SECRET', planType: 'private' } } });
  }
  if (message.method === 'windowsSandbox/readiness') send({ id: message.id, result: { status: mode === 'sandbox-missing' ? 'notConfigured' : 'ready' } });
});
input.on('close', () => { process.exitCode = mode === 'exit-error' ? 7 : 0; });
