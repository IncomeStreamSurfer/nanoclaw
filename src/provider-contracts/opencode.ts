import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract } from './registry.js';

/** Deep clone that carries contract functions (the settings transform) by reference. */
function cloneSurfaces<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneSurfaces(entry)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneSurfaces(entry)])) as T;
  }
  return value;
}

const inherited = cloneSurfaces(CLAUDE_COMPATIBLE_HOST_SURFACES);
// OpenCode inherits the current Claude document plane without adding
// protection, so the inherited sourceProtection is dropped.
const { sourceProtection: _claudeOnlyProtection, ...projectDocument } = inherited.projectDocument;

registerProviderHostContract('opencode', {
  ...inherited,
  projectDocument,
  stateVolumes: [
    ...inherited.stateVolumes,
    {
      id: 'opencode-data',
      directory: 'opencode-xdg',
      containerPath: '/opencode-xdg',
      scope: 'session',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  files: inherited.files.map((file) => ({
    ...file,
    reconcile: file.reconcile === undefined ? undefined : { ...file.reconcile, transformerProvider: 'claude' },
  })),
  spawnOperations: [
    { kind: 'state-volume', id: 'opencode-data' },
    { kind: 'legacy-overlay' },
    { kind: 'skill-backing', id: 'claude-skills', action: 'sync' },
    { kind: 'project-document' },
  ],
  environment: 'legacy-overlay',
  legacyHostAdapter: 'required',
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
