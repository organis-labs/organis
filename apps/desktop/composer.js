const composer = document.querySelector('.composer');
const chatAgent = document.querySelector('#chat-agent');
const chatPermission = document.querySelector('#chat-permission');
const chatSubmit = document.querySelector('#chat-submit');
const queryButton = document.querySelector('#send-codex');
const proposalButton = document.querySelector('#propose-codex-change');
const composerStatus = document.querySelector('#composer-status');
const chatPrompt = document.querySelector('#codex-prompt');
const markdownPreview = document.querySelector('#markdown-preview');
const previewToggle = document.querySelector('#markdown-preview-toggle');
const settings = document.querySelector('#settings');

document.querySelector('#open-settings').addEventListener('click', () => settings.showModal());
document.querySelector('#close-settings').addEventListener('click', () => settings.close());

function updateComposer() {
  const codexAvailable = chatAgent.value === 'codex';
  const isProposal = chatPermission.value === 'propose';
  chatSubmit.disabled = chatPermission.disabled = !codexAvailable;
  queryButton.hidden = isProposal;
  proposalButton.hidden = !isProposal;
  composerStatus.textContent = !codexAvailable
    ? (chatAgent.value === 'claude' ? 'Claude uses the terminal connection in Settings.' : 'An LLM provider is not available in this preview.')
    : isProposal ? 'Codex receives the selected file. The proposal is saved in run history and requires your approval.'
      : 'Codex runs read-only.';
}
chatAgent.addEventListener('change', updateComposer);
chatPermission.addEventListener('change', updateComposer);
updateComposer();

composer.addEventListener('submit', event => {
  if (chatSubmit.disabled || queryButton.hidden) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, { capture: true });
chatPrompt.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
  event.preventDefault();
  if (chatSubmit.disabled || !chatPrompt.reportValidity()) return;
  (queryButton.hidden ? proposalButton : queryButton).click();
});

function appendInline(parent, text) {
  const tokens = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let end = 0;
  for (const token of text.matchAll(tokens)) {
    parent.append(text.slice(end, token.index));
    const element = document.createElement(token[1] ? 'code' : 'strong');
    element.textContent = token[1] ?? token[2];
    parent.append(element);
    end = token.index + token[0].length;
  }
  parent.append(text.slice(end));
}

function renderMarkdown() {
  if (markdownPreview.hidden) return;
  const fragment = document.createDocumentFragment();
  let code;
  let list;
  for (const line of chatPrompt.value.split('\n')) {
    if (line.startsWith('```')) {
      list = undefined;
      if (code) code = undefined;
      else {
        const block = document.createElement('pre');
        code = document.createElement('code');
        block.append(code);
        fragment.append(block);
      }
    } else if (code) {
      code.append(line + '\n');
    } else if (/^[-*] /.test(line)) {
      if (!list) {
        list = document.createElement('ul');
        fragment.append(list);
      }
      const item = document.createElement('li');
      appendInline(item, line.slice(2));
      list.append(item);
    } else {
      list = undefined;
      if (!line.trim()) continue;
      const heading = /^(#{1,3}) (.+)$/.exec(line);
      const block = document.createElement(heading ? `h${heading[1].length + 2}` : 'p');
      appendInline(block, heading ? heading[2] : line);
      fragment.append(block);
    }
  }
  markdownPreview.replaceChildren(fragment);
}

previewToggle.addEventListener('click', () => {
  markdownPreview.hidden = !markdownPreview.hidden;
  previewToggle.setAttribute('aria-expanded', String(!markdownPreview.hidden));
  renderMarkdown();
});
chatPrompt.addEventListener('input', renderMarkdown);
