// @ts-check
(() => {
  const api = window.organisCollaboration;
  if (!api) return;

  /** @param {string} name */
  const field = name => /** @type {HTMLElement & {disabled?: boolean}} */ (document.querySelector(`#collaboration-${name}`));
  const room = /** @type {HTMLElement} */ (document.querySelector('#collaboration'));
  const prepare = /** @type {HTMLButtonElement} */ (document.querySelector('#prepare-collaboration'));
  const project = /** @type {HTMLSelectElement} */ (document.querySelector('#saved-project'));
  const prompt = /** @type {HTMLTextAreaElement} */ (document.querySelector('#codex-prompt'));
  const composer = /** @type {HTMLFormElement} */ (document.querySelector('#codex-question'));
  const codexActions = /** @type {HTMLElement} */ (document.querySelector('#chat-submit'));
  const launchError = field('launch-error');
  const testEntry = /** @type {HTMLDetailsElement} */ (field('test-entry'));
  const testForm = /** @type {HTMLFormElement} */ (field('test-form'));

  /** @type {Partial<Record<import('../../packages/runtime/src/collaboration-types.mjs').CollaborationPhase, keyof typeof api>>} */
  const availableAction = {
    'ready-to-plan': 'plan',
    'ready-to-propose': 'propose',
    'awaiting-approval': 'apply',
    'ready-to-review': 'review',
    'revision-requested': 'revise'
  };
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'revision-limit']);
  const phases = {
    'ready-to-plan': 'Confirm what Claude will receive.',
    planning: 'Claude is preparing a plan.',
    'ready-to-propose': 'Confirm the brief before sending it to Codex.',
    proposing: 'Codex is preparing a replacement.',
    'awaiting-approval': 'Check the original and replacement before approving.',
    applying: 'Waiting for your decision in the approval dialog.',
    'ready-to-review': 'Confirm what Claude will receive for review.',
    reviewing: 'Claude is reviewing the applied change.',
    'revision-requested': 'Claude requested a revision.',
    completed: 'Review complete.',
    failed: 'The task failed.',
    cancelled: 'The task was cancelled.',
    interrupted: 'The task was interrupted.',
    'verification-required': 'Check the selected file before starting another task.',
    cancelling: 'Waiting for the active operation to stop.',
    'revision-limit': 'The revision limit was reached.'
  };
  const verdicts = { passed: 'Claude review passed', revision: 'Claude requested changes', failed: 'Claude review failed' };
  const stageNames = { plan: 'Claude plan', codex: 'Codex proposal', apply: 'File approval', review: 'Claude review' };
  const refreshError = 'Unable to refresh the collaboration. Retrying…';

  /** @type {import('../../packages/runtime/src/collaboration-types.mjs').CollaborationSnapshot | undefined} */
  let task;
  /** @type {string | undefined} */
  let pending;
  let cancelling = false;
  let refreshing = false;
  let generation = 0;
  /** @type {import('../../packages/runtime/src/collaboration-types.mjs').CollaborationRequest | undefined} */
  let command;
  let pollingFailed = false;

  /** @param {HTMLElement} element */
  function write(element, text = '') {
    if (element.textContent !== text) element.textContent = text;
  }

  /** @param {string} name @param {boolean} visible */
  function show(name, visible) {
    field(name).hidden = !visible;
  }

  function setError(message = '') {
    pollingFailed = false;
    write(field('error'), task ? message : '');
    write(launchError, task ? '' : message);
    launchError.hidden = Boolean(task) || !message;
  }

  function render() {
    room.hidden = !task;
    prepare.disabled = Boolean(task || pending);
    const running = Boolean(task && !terminal.has(task.phase));
    codexActions.inert = running || pending === 'prepare';
    if (!task) {
      delete room.dataset.phase;
      return;
    }

    const { phase, plan, proposal, review, applied, tests = [], runs = [] } = task;
    room.dataset.phase = phase;
    write(field('status'), task.message || phases[phase] || '');
    write(field('target'), task.target ?? task.fileName);
    write(field('attempt'), `Attempt ${task.attempt} · ${task.revisionLimit} revision allowed`);
    show('brief', phase === 'ready-to-plan');
    write(field('request'), task.request);
    show('plan-view', Boolean(plan));
    write(field('summary'), plan?.summary);

    const assigning = phase === 'ready-to-propose';
    show('assignment', assigning);
    write(field('instructions'), assigning ? task.instructions ?? plan?.instructions : '');
    write(field('criteria'), assigning
      ? Array.isArray(plan?.criteria) ? plan.criteria.map(item => `• ${item}`).join('\n') : plan?.criteria
      : '');
    write(field('current'), assigning ? task.original : '');

    show('change', Boolean(proposal));
    write(field('change-heading'), applied ? 'Applied change' : 'Review the proposed replacement');
    show('review-scope', phase === 'ready-to-review');
    show('review-criteria', phase === 'ready-to-review');
    write(field('review-criteria'), phase === 'ready-to-review' ? plan?.criteria.map(item => `• ${item}`).join('\n') : '');
    write(field('original'), proposal?.original);
    write(field('replacement'), proposal?.replacement);
    const showApplied = applied || phase === 'applying';
    show('applied', showApplied);
    write(field('applied'), showApplied ? 'Approved replacement applied to this file.' : '');

    const canRecord = phase === 'ready-to-review' && Boolean(task.revision) && tests.length < 4;
    show('verification', Boolean(applied));
    show('test-entry', canRecord);
    show('test-records', tests.length > 0);
    write(field('test-status'), tests.length
      ? 'User-reported tests are shared with Claude.'
      : 'No test execution recorded. Claude’s review does not verify that tests ran.');
    write(field('test-revision'), canRecord ? `Applied revision: ${task.revision}` : '');
    const testEvidence = tests.map(({ command, actor, exitCode, result, revision }) =>
      `${command}\nRun by: ${actor} · Exit code: ${exitCode}\n${result}\nRevision: ${revision}`);
    write(field('test-records'), testEvidence.join('\n\n'));

    show('review-view', Boolean(review));
    write(field('verdict'), review ? verdicts[review.verdict] : '');
    write(field('review-summary'), review?.summary);
    show('history', Boolean(runs.length));
    const identifiers = `Room: ${task.roomId}\nTask: ${task.id}`;
    const executionRecords = runs.map(run => {
      const label = [stageNames[run.stage], run.state, `Attempt ${run.attempt}`].join(' · ');
      return `${label}\n${run.runId ?? run.id ?? ''}`;
    });
    write(field('runs'), [identifiers, ...executionRecords].join('\n\n'));

    for (const action of ['plan', 'propose', 'apply', 'review', 'revise']) {
      show(action, availableAction[phase] === action);
      field(action).disabled = Boolean(pending || cancelling);
    }
    field('record-test').disabled = Boolean(pending || cancelling);
    show('cancel', running && phase !== 'cancelling' && phase !== 'verification-required');
    field('cancel').disabled = cancelling;
    const acknowledge = phase === 'verification-required' && task.canAcknowledgeUncertainWrite;
    show('dismiss', phase === 'verification-required' ? acknowledge : terminal.has(phase));
    write(field('dismiss'), acknowledge ? 'I checked the file' : 'Close task');
    field('dismiss').disabled = Boolean(pending || cancelling);
  }

  /** @param {import('../../packages/runtime/src/collaboration-types.mjs').CollaborationSnapshot | null} snapshot */
  function update(snapshot) {
    const opened = !task && snapshot;
    if (snapshot?.id !== task?.id || snapshot?.attempt !== task?.attempt) {
      testForm.reset();
      testEntry.open = false;
      setError();
    }
    task = snapshot ?? undefined;
    render();
    if (opened) room.scrollIntoView({ block: 'nearest' });
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const version = generation;
    try {
      const snapshot = await api.status();
      if (version === generation) {
        if (pollingFailed) setError();
        update(snapshot);
      }
    } catch {
      if (version === generation && task && !field('error').textContent) {
        setError(refreshError);
        pollingFailed = true;
      }
    } finally {
      refreshing = false;
    }
  }

  /** @param {string} action @param {() => ReturnType<typeof api.status>} operation */
  async function perform(action, operation) {
    if (pending || cancelling) return;
    pending = action;
    const version = ++generation;
    setError();
    render();
    try {
      const snapshot = await operation();
      if (version === generation && snapshot !== undefined) update(snapshot);
    } catch (error) {
      if (version === generation) setError(/** @type {Error} */ (error).message);
    } finally {
      generation++;
      pending = undefined;
      render();
      void refresh();
    }
  }

  prepare.addEventListener('click', () => {
    const projectId = project.value;
    const request = prompt.value.trim();
    if (!projectId || !request) {
      setError('Choose a project and describe the change first.');
      return;
    }
    if (!command || command.projectId !== projectId || command.request !== request) {
      command = { projectId, request, commandId: crypto.randomUUID() };
    }
    const requestToSend = command;
    void perform('prepare', async () => {
      const prepared = await api.prepare(requestToSend);
      command = undefined;
      return prepared;
    });
  });

  for (const action of /** @type {const} */ (['plan', 'propose', 'apply', 'review', 'revise', 'dismiss'])) {
    field(action).addEventListener('click', () => {
      const activeTask = task;
      if (activeTask) void perform(action, () => api[action](activeTask.id, activeTask.attempt));
    });
  }

  field('cancel').addEventListener('click', async () => {
    if (!task || cancelling) return;
    cancelling = true;
    generation++;
    setError();
    render();
    try {
      const snapshot = await api.cancel(task.id, task.attempt);
      if (snapshot !== undefined) update(snapshot);
    } catch (error) {
      setError(/** @type {Error} */ (error).message);
    } finally {
      generation++;
      cancelling = false;
      render();
      void refresh();
    }
  });

  testForm.addEventListener('submit', event => {
    event.preventDefault();
    if (task?.phase !== 'ready-to-review' || !task.revision) return;
    const form = new FormData(testForm);
    const record = {
      id: task.id, attempt: task.attempt, revision: task.revision,
      command: String(form.get('command')).trim(), actor: String(form.get('actor')).trim(),
      exitCode: Number(form.get('exitCode')), result: String(form.get('result')).trim()
    };
    void perform('record-test', async () => {
      const snapshot = await api.recordTest(record);
      testForm.reset();
      testEntry.open = false;
      return snapshot;
    });
  });

  composer.addEventListener('submit', event => {
    if (!codexActions.inert) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  composer.addEventListener('keydown', event => {
    if (!codexActions.inert || event.target !== prompt || event.isComposing
        || event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });

  render();
  void refresh();
  setInterval(() => { if (task || pending) void refresh(); }, 1000);
})();
