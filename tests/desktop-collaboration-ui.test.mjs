import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../apps/desktop/collaboration.js', import.meta.url), 'utf8');

const savedRooms = { selectedRoomId: 'room', rooms: [{ id: 'room', name: 'Saved room',
  participants: { claude: 'planner', codex: 'writer' } }] };

function renderer(api) {
  const nodes = new Map();
  let poll;
  const get = id => {
    if (!nodes.has(id)) {
      const events = new Map();
      nodes.set(id, {
        value: '', dataset: {}, textContent: '', reset() {}, scrollIntoView() {}, replaceChildren() {},
        addEventListener(type, callback) { events.set(type, callback); },
        event(type, event) { return events.get(type)(event); }
      });
    }
    return nodes.get(id);
  };
  const click = async id => {
    const element = get(id);
    assert.ok(!element.hidden && !element.disabled, `${id} can be clicked`);
    await element.event('click');
    await setImmediate();
  };
  vm.runInNewContext(script, {
    window: { organisCollaboration: { listRooms: async () => savedRooms, ...api } },
    document: { querySelector: get },
    Option: function Option() {},
    crypto: { randomUUID: () => 'command-id' },
    setInterval(callback) { poll = callback; }
  });
  return { get, click, async refresh() { poll(); await setImmediate(); } };
}

test('collaboration exposes each handoff before sending and separates application, review and test evidence', async () => {
  const base = { id: 'task', attempt: 1, revisionLimit: 1, target: 'fixtures/notes.txt',
    original: 'Before', request: 'Replace Before with After' };
  const actions = [];
  let task;
  const stage = (name, phase, fields = {}) => async (...args) => {
    actions.push([name, ...args]);
    task = { ...base, ...task, ...fields, phase };
    return task;
  };
  const ui = renderer({
    status: async () => task ?? null,
    prepare: stage('prepare', 'ready-to-plan'),
    plan: stage('plan', 'ready-to-propose', {
      plan: { summary: 'Change the label', instructions: 'Set the text to After', criteria: ['Keep one line'] }
    }),
    propose: stage('propose', 'awaiting-approval', {
      proposal: { original: 'Before', replacement: 'After' }
    }),
    apply: stage('apply', 'ready-to-review', { applied: true, revision: 'sha256:result' }),
    review: stage('review', 'completed', { review: { verdict: 'passed', summary: 'Matches the plan' } })
  });
  await setImmediate();
  ui.get('#saved-project').value = 'project';
  ui.get('#codex-prompt').value = base.request;

  await ui.click('#prepare-collaboration');
  assert.equal(actions.length, 1);
  assert.equal(actions[0][1].commandId, 'command-id');
  assert.equal(actions[0][1].roomId, 'room');
  assert.equal(ui.get('#collaboration-request').textContent, base.request);
  assert.equal(ui.get('#chat-submit').inert, true);
  assert.equal(ui.get('#collaboration-propose').hidden, true);

  await ui.click('#collaboration-plan');
  assert.equal(ui.get('#collaboration-instructions').textContent, 'Set the text to After');
  assert.equal(ui.get('#collaboration-current').textContent, 'Before');
  await ui.click('#collaboration-propose');
  assert.equal(ui.get('#collaboration-replacement').textContent, 'After');
  assert.equal(ui.get('#collaboration-applied').hidden, true);
  assert.equal(ui.get('#collaboration-review').hidden, true);

  await ui.click('#collaboration-apply');
  assert.equal(ui.get('#collaboration-applied').hidden, false);
  assert.equal(ui.get('#collaboration-review-view').hidden, true);
  assert.match(ui.get('#collaboration-test-status').textContent, /No test execution recorded/);
  await ui.click('#collaboration-review');
  assert.equal(ui.get('#collaboration-verdict').textContent, 'Claude review passed');
  assert.match(ui.get('#collaboration-test-status').textContent, /No test execution recorded/);
  assert.deepEqual(actions.slice(1), [
    ['plan', 'task', 1], ['propose', 'task', 1], ['apply', 'task', 1], ['review', 'task', 1]
  ]);
  assert.equal(ui.get('#codex-prompt').value, base.request);
});

test('room creation and membership must complete before collaboration can start', async () => {
  let state = { selectedRoomId: null, rooms: [] };
  const ui = renderer({
    listRooms: async () => state,
    status: async () => null,
    createRoom: async name => (state = { selectedRoomId: 'new', rooms: [{ id: 'new', name, participants: {} }] }),
    addParticipant: async (id, provider) => {
      assert.equal(id, 'new');
      state.rooms[0].participants[provider] = provider + '-id';
      return state;
    }
  });
  await setImmediate();
  assert.equal(ui.get('#prepare-collaboration').disabled, true);
  ui.get('#room-name').value = 'New room';
  ui.get('#room-create').event('submit', { preventDefault() {} });
  await setImmediate();
  assert.equal(ui.get('#room-select').value, 'new');
  await ui.click('#room-add-claude');
  assert.equal(ui.get('#prepare-collaboration').disabled, true);
  await ui.click('#room-add-codex');
  assert.equal(ui.get('#prepare-collaboration').disabled, false);
  assert.equal(ui.get('#room-members').textContent, 'Claude (lead) · Codex');
});

test('cancel remains available during planning and a late plan cannot replace the cancelled task', async () => {
  const initial = { id: 'task', attempt: 1, revisionLimit: 1, phase: 'ready-to-plan' };
  const inFlight = Promise.withResolvers();
  let task = initial;
  const ui = renderer({
    status: async () => task,
    plan: () => inFlight.promise,
    cancel: async () => (task = { ...initial, phase: 'cancelled' })
  });
  await setImmediate();
  await ui.click('#collaboration-plan');
  await ui.click('#collaboration-cancel');
  inFlight.resolve({ ...initial, phase: 'ready-to-propose' });
  await setImmediate();
  assert.equal(ui.get('#collaboration').dataset.phase, 'cancelled');
  assert.equal(ui.get('#collaboration-propose').hidden, true);
  assert.equal(ui.get('#collaboration-dismiss').hidden, false);
});

test('status failures and recovery preserve the last action error', async () => {
  const task = { id: 'task', attempt: 1, revisionLimit: 1, phase: 'ready-to-plan' };
  let statusFails = false;
  const ui = renderer({
    async status() {
      if (statusFails) throw new Error('Connection unavailable.');
      return task;
    },
    async plan() {
      statusFails = true;
      throw new Error('Claude requires sign-in.');
    }
  });
  await setImmediate();
  const error = ui.get('#collaboration-error');

  statusFails = true;
  await ui.refresh();
  assert.match(error.textContent, /Retrying/);
  statusFails = false;
  await ui.refresh();
  assert.equal(error.textContent, '');

  await ui.click('#collaboration-plan');
  assert.equal(error.textContent, 'Claude requires sign-in.');
  await ui.refresh();
  assert.equal(error.textContent, 'Claude requires sign-in.');
  statusFails = false;
  await ui.refresh();
  assert.equal(error.textContent, 'Claude requires sign-in.');
});
