import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../apps/desktop/execution.js', import.meta.url), 'utf8');

async function renderer() {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) {
      let text = selector === '#execution-status' ? 'Loading saved runs…' : '';
      const handlers = new Map();
      elements.set(selector, {
        writes: 0, disabled: false, value: 'complete',
        get textContent() { return text; },
        set textContent(value) { text = value; this.writes++; },
        addEventListener(type, handler) { handlers.set(type, handler); },
        click() { return handlers.get('click')(); },
        replaceChildren() {}, closest() { return null; }, classList: { contains: () => false }
      });
    }
    return elements.get(selector);
  }
  const api = {
    listError: null,
    async list() { if (this.listError) throw this.listError; return []; },
    async chooseWorkspace() { return '/synthetic/workspace'; },
    async start() { throw new Error('Workspace is no longer available.'); },
    async reconcile() {}
  };
  let poll;
  runInNewContext(source, {
    window: { organisExecution: api },
    document: { querySelector: element, activeElement: element('body') },
    crypto: { randomUUID }, setInterval: callback => { poll = callback; }
  });
  await new Promise(setImmediate);
  return { api, element, poll, status: element('#execution-status') };
}

test('empty saved-run polls do not rewrite the unchanged live region', async () => {
  const { poll, status } = await renderer();
  assert.equal(status.textContent, 'No saved runs yet.');
  assert.equal(status.writes, 1);
  await poll();
  await poll();
  assert.equal(status.writes, 1);
});

test('poll errors are announced once and cleared when the runtime recovers', async () => {
  const { api, poll, status } = await renderer();
  api.listError = new Error('Storage unavailable');
  await poll();
  assert.equal(status.textContent, 'Saved runs unavailable: Storage unavailable');
  const writes = status.writes;
  await poll();
  assert.equal(status.writes, writes);
  api.listError = null;
  await poll();
  assert.equal(status.textContent, 'No saved runs yet.');
  assert.equal(status.writes, writes + 1);
});

test('failed start remains visible across empty, failed and recovered polls', async () => {
  const { api, element, poll, status } = await renderer();
  await element('#choose-workspace').click();
  await element('#start-fixture').click();
  assert.equal(status.textContent, 'Workspace is no longer available.');
  const writes = status.writes;
  await poll();
  api.listError = new Error('Storage unavailable');
  await poll();
  api.listError = null;
  await poll();
  assert.equal(status.textContent, 'Workspace is no longer available.');
  assert.equal(status.writes, writes);
});

test('a polling failure replaces an action success notice and then recovers', async () => {
  const { api, element, poll, status } = await renderer();
  await element('#choose-workspace').click();
  await element('#start-fixture').click();
  await element('#reconcile-runs').click();
  assert.match(status.textContent, /^Reconciliation checked/);
  api.listError = new Error('Storage unavailable');
  await poll();
  assert.equal(status.textContent, 'Saved runs unavailable: Storage unavailable');
  api.listError = null;
  await poll();
  assert.equal(status.textContent, 'No saved runs yet.');
});
