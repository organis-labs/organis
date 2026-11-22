import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const renderer = await readFile(new URL('../apps/desktop/agents.js', import.meta.url), 'utf8');

function settings() {
  const requests = [];
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', validity: '', validityReports: 0,
      addEventListener(event, handler) { this[event] = handler; },
      setCustomValidity(message) { this.validity = message; },
      reportValidity() { this.validityReports++; }
    });
    return elements.get(selector);
  }
  runInNewContext(renderer, {
    document: { querySelector: element },
    window: { organisAgents: { setModel(agent, model) {
      const deferred = Promise.withResolvers();
      requests.push({ agent, model, ...deferred });
      return deferred.promise;
    } } }
  });
  return { input: element('#codex-model'), requests };
}

for (const outcome of ['resolve', 'reject']) {
  test(`a model save that settles via ${outcome} preserves input typed while waiting`, async () => {
    const { input, requests } = settings();
    input.value = ' model-a ';
    const first = input.change();
    input.value = ' model-b ';
    input.input();
    requests[0][outcome](new Error('synthetic rejection'));
    await first;
    assert.equal(input.value, ' model-b ');
    assert.equal(input.validityReports, 0);

    const second = input.change();
    assert.equal(requests[1].model, 'model-b');
    requests[1].resolve();
    await second;
    assert.equal(input.value, 'model-b');

    input.value = 'invalid value';
    input.input();
    const invalid = input.change();
    requests[2].reject(new Error('synthetic rejection'));
    await invalid;
    assert.equal(input.value, 'model-b');
    assert.equal(input.validityReports, 1);
  });
}
