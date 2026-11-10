import { parseArgs } from 'node:util';
import { RuntimeError } from '../../../packages/runtime/src/contracts.mjs';
import { ProjectRegistry } from '../../../packages/runtime/src/projects.mjs';

export async function projectCommand([command, ...args]) {
  const signatures = { list: 0, add: 1, show: 1, remove: 1, 'set-path': 2, 'remove-path': 2 };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      'state-dir': { type: 'string' }, json: { type: 'boolean' },
      ...(command === 'set-path' ? { access: { type: 'string' } } : {})
    }, tokens: true });
  } catch (error) {
    throw new RuntimeError('INVALID_ARGUMENT', error.message);
  }
  const { values, positionals: [first, second], tokens } = parsed;
  const options = tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (parsed.positionals.length !== signatures[command] || new Set(options).size !== options.length || values['state-dir'] === '') {
    throw new RuntimeError('INVALID_ARGUMENT', 'Use project list|add <directory>|show <id>|remove <id>|set-path <id> <path>|remove-path <id> <path-id>.');
  }
  const registry = new ProjectRegistry(values['state-dir']);
  try {
    const actions = {
      list: async () => ({ projects: await registry.list() }),
      add: async () => ({ project: await registry.addProject(first) }),
      show: () => registry.preview(first),
      remove: () => { registry.removeProject(first); return { removed: first }; },
      'set-path': async () => ({ path: await registry.setPath(first, second, values.access) }),
      'remove-path': () => { registry.removePath(first, second); return { removed: second }; }
    };
    console.log(JSON.stringify(await actions[command](), null, values.json ? 0 : 2));
  } finally {
    registry.close();
  }
}
