import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const renderer = readFileSync(new URL('../apps/desktop/agents.js', import.meta.url), 'utf8');

function questionUI(results, fileChange = {}) {
  const elements = new Map();
  const timers = [];
  const cancellations = [];
  function select(id) {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, {
        value: 'synthetic', handlers, addEventListener: (event, fn) => { handlers[event] = fn; }
      });
    }
    return elements.get(id);
  }
  runInNewContext(renderer, {
    document: { querySelector: select },
    window: { organisExecution: {
      ...fileChange,
      startCodex: async () => ({ id: 'run-1' }),
      codexResult: async () => {
        const result = results.shift();
        if (result instanceof Error) throw result;
        return result;
      },
      cancel: async request => {
        cancellations.push(request.id);
        if (cancellations.length === 1) throw new Error('Unable to cancel right now.');
      }
    } },
    crypto: { randomUUID: () => 'test-command' },
    setTimeout: callback => timers.push(callback)
  });
  return {
    select,
    send: select('#send-codex'), cancel: select('#cancel-codex-turn'), status: select('#codex-turn-status'),
    answer: select('#codex-answer'), approval: select('#codex-approval'),
    approvalDetails: select('#codex-approval-details'), cancellations,
    submit: () => select('#codex-question').handlers.submit({ preventDefault() {} }),
    async poll() {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(timers.length, 1);
      timers.shift()();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('Codex retains controls after a failed lookup and preserves cancellation errors across polling', async () => {
  const ui = questionUI([
    new Error('Temporary lookup failure.'), { state: 'running' }, new Error('Another lookup failure.'),
    { state: 'cancelling' }, { state: 'cancelled' }
  ]);
  const ended = ui.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.cancel.hidden, false);
  assert.match(ui.status.textContent, /Retrying/);

  await ui.cancel.handlers.click();
  assert.equal(ui.status.textContent, 'Unable to cancel right now.');
  assert.equal(ui.cancel.disabled, false);
  await ui.poll();
  await ui.poll();
  assert.equal(ui.status.textContent, 'Unable to cancel right now.');
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.cancel.hidden, false);

  await ui.cancel.handlers.click();
  await ui.poll();
  assert.equal(ui.status.textContent, 'Waiting for Codex to stop…');
  await ui.poll();
  await ended;
  assert.deepEqual(ui.cancellations, ['run-1', 'run-1']);
  assert.equal(ui.status.textContent, 'Run cancelled.');
  assert.equal(ui.cancel.hidden, true);
  assert.equal(ui.send.disabled, false);
});

test('Codex shows the pending approval preview and clears it when the run ends', async () => {
  const ui = questionUI([
    { state: 'awaiting_approval', approval: { approvalId: 'pending', preview: {
      kind: 'file-change', changes: [{ path: 'notes.txt', action: 'add', diff: '+proposal' }]
    } } },
    { state: 'cancelled' }
  ]);
  const ended = ui.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.approval.hidden, false);
  assert.match(ui.approvalDetails.textContent, /notes\.txt/);
  assert.match(ui.approvalDetails.textContent, /\+proposal/);

  await ui.poll();
  await ended;
  assert.equal(ui.approval.hidden, true);
  assert.equal(ui.approvalDetails.textContent, '');
});

test('Codex displays a completed answer after recovering from a lookup failure', async () => {
  const ui = questionUI([new Error('Temporary lookup failure.'), { state: 'completed', answer: '42' }]);
  const ended = ui.submit();
  await ui.poll();
  await ended;
  assert.equal(ui.status.textContent, 'Answer received.');
  assert.equal(ui.answer.textContent, '42');
  assert.equal(ui.answer.hidden, false);
});

test('desktop shows the replacement for review and sends only the proposal ID on approval', async () => {
  const originals = [];
  const reviews = [];
  const ui = questionUI([], {
    startFileChange: async input => {
      originals.push(input.instructions);
      return { id: 'proposal-id', target: 'notes.txt', original: 'old text', replacement: '<script>new text</script>' };
    },
    approveFileChange: async id => { reviews.push(id); return true; }
  });
  await ui.select('#propose-codex-change').handlers.click();
  assert.deepEqual(originals, ['synthetic']);
  assert.deepEqual(reviews, []);
  assert.equal(ui.select('#codex-change-review').hidden, false);
  assert.equal(ui.select('#codex-change-replacement').textContent, '<script>new text</script>');
  await ui.select('#approve-codex-change').handlers.click();
  assert.deepEqual(reviews, ['proposal-id']);
  assert.equal(ui.select('#codex-change-status').textContent, 'Approved change applied.');
  assert.equal(ui.select('#codex-change-review').hidden, true);
  assert.equal(ui.select('#codex-change-replacement').textContent, '');
});
