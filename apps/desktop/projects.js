const projectApi = window.organisProjects;
const projectSelect = document.querySelector('#saved-project');
const projectStatus = document.querySelector('#project-status');
const projectDetails = document.querySelector('#project-details');
const projectDraft = document.querySelector('#project-draft');
const projectAccess = document.querySelector('#project-access');
const projectRemove = document.querySelector('#remove-project');
const projectFile = document.querySelector('#pick-project-file');
const projectFolder = document.querySelector('#pick-project-folder');
const projectSave = document.querySelector('#save-project-path');
const projectActions = [...document.querySelectorAll('#projects button, #projects select')];
let draft;

function clearDraft() {
  draft = undefined;
  projectDraft.hidden = true;
}

async function renderProject() {
  projectDetails.replaceChildren();
  if (!projectSelect.value) return;
  const preview = await projectApi.preview(projectSelect.value);
  const description = document.createElement('p');
  const { sandbox, approvalMode, commandNetwork } = preview.requested;
  description.textContent = `Requested: ${sandbox}, ${approvalMode} approval, command network ${commandNetwork ? 'enabled' : 'disabled'}. Effective policy unavailable. ${preview.reason}`;
  projectDetails.append(description);
  const paths = document.createElement('ul');
  for (const entry of preview.paths) {
    const item = document.createElement('li');
    item.textContent = `${entry.path} (${entry.kind}, requested ${entry.access}, ${entry.status}) `;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove path';
    remove.addEventListener('click', () => act(async () => {
      await projectApi.removePath({ projectId: preview.project.id, pathId: entry.id });
      await renderProject();
    }));
    item.append(remove);
    paths.append(item);
  }
  projectDetails.append(paths);
}

async function refresh(selected = projectSelect.value) {
  const projects = await projectApi.list();
  projectSelect.replaceChildren(new Option('Select a project', ''));
  for (const project of projects) projectSelect.add(new Option(`${project.path} (${project.status})`, project.id));
  if (projects.some(project => project.id === selected)) projectSelect.value = selected;
  await renderProject();
}

let busy = false;
async function act(action) {
  if (busy) return;
  busy = true;
  for (const control of projectActions) control.disabled = true;
  try {
    await action();
    projectStatus.textContent = 'Registry saved on this device. No agent permissions are active.';
  } catch (error) {
    projectStatus.textContent = error.message;
  } finally {
    busy = false;
    for (const control of projectActions) control.disabled = false;
    projectFile.disabled = projectFolder.disabled = projectRemove.disabled = !projectSelect.value;
  }
}

async function pick(kind) {
  clearDraft();
  draft = await projectApi.pick({ kind, projectId: projectSelect.value });
  if (!draft) return;
  draft.project = kind === 'project';
  projectAccess.value = 'read';
  projectAccess.closest('label').hidden = draft.project;
  document.querySelector('#project-picked-path').textContent = `${draft.path} (${draft.kind}). Saved until removed.`;
  projectSave.textContent = draft.project ? 'Register project' : 'Save requested access';
  projectDraft.hidden = false;
}

document.querySelector('#pick-project').addEventListener('click', () => act(() => pick('project')));
projectFile.addEventListener('click', () => act(() => pick('file')));
projectFolder.addEventListener('click', () => act(() => pick('directory')));
projectSelect.addEventListener('change', () => act(async () => { clearDraft(); await renderProject(); }));
document.querySelector('#refresh-projects').addEventListener('click', () => act(async () => { clearDraft(); await refresh(); }));
projectRemove.addEventListener('click', () => act(async () => {
  clearDraft();
  await projectApi.removeProject(projectSelect.value);
  await refresh();
}));
projectSave.addEventListener('click', () => act(async () => {
  const selection = draft;
  clearDraft();
  const saved = await projectApi.save({ token: selection.token, access: projectAccess.value });
  if (selection.project) await refresh(saved.id);
  else await renderProject();
}));
act(() => refresh());
