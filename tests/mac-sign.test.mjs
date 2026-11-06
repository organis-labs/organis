import test from 'node:test';
import assert from 'node:assert/strict';
import { signMac } from '../scripts/mac-sign.mjs';

test('Mac signing preserves the resolved certificate hash and signing protections', async () => {
  const options = {
    identity: 'a'.repeat(40), app: '/test/Organis.app', platform: 'darwin',
    identityValidation: false, hardenedRuntime: true,
    optionsForFile: () => ({ entitlements: '/test/entitlements.plist' })
  };
  let received;
  await signMac(options, async value => { received = value; });
  assert.deepEqual(received, { ...options, identityValidation: true });
  assert.equal(options.identityValidation, false);
});

test('Mac signing rejects names and ad-hoc identities before invoking codesign', async () => {
  for (const identity of [undefined, '-', 'Developer ID Application: Example (TEAM)', 'a'.repeat(39)]) {
    await assert.rejects(signMac({ identity }, () => assert.fail('must not sign')), /certificate SHA-1/);
  }
});
