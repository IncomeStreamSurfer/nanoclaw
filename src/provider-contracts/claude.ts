import { DEFAULT_PROJECT_DOC } from '../project-doc-compose.js';
import { CLAUDE_DEFAULT_SETTINGS, claudeSettingsTransformer } from '../migrate-claude-memory-settings.js';

import { registerProviderHostContract, type ProviderHostContract } from './registry.js';

export const CLAUDE_COMPATIBLE_HOST_SURFACES = {
  projectDocument: {
    fileName: DEFAULT_PROJECT_DOC.fileName,
    maxBytes: DEFAULT_PROJECT_DOC.maxBytes,
    containerPath: '/workspace/agent/CLAUDE.md',
    mountClass: 'group-state',
    sourceProtection: 'install-surface',
  },
  stateVolumes: [
    {
      id: 'claude-home',
      directory: '.claude-shared',
      containerPath: '/home/node/.claude',
      scope: 'group',
      mode: 'rw',
      mountClass: 'group-state',
    },
  ],
  skillBackings: [
    {
      id: 'claude-skills',
      location: { kind: 'state-volume', volumeId: 'claude-home', subdirectory: '' },
      skillsSubdirectory: 'skills',
      sharedLinks: { prune: 'symlinks-only' },
      conflictDiagnostics: 'warn',
      templateCopies: 'in-place',
    },
  ],
  skillViews: [
    {
      backingId: 'claude-skills',
      containerPath: '/home/node/.claude/skills',
      mode: 'rw',
      mountClass: 'group-state',
      mount: 'parent-volume',
    },
  ],
  files: [
    {
      id: 'claude-settings',
      volumeId: 'claude-home',
      relativePath: 'settings.json',
      prepare: {
        operation: 'create-if-missing',
        when: 'group-init',
        content: CLAUDE_DEFAULT_SETTINGS,
        mode: 'process-default',
      },
      contentOwner: 'provider',
      reconcile: {
        transform: claudeSettingsTransformer,
        when: 'group-init',
        write: 'atomic-replace',
      },
    },
  ],
  groupInitOperations: [
    { kind: 'state-volume', id: 'claude-home' },
    { kind: 'prepared-file', id: 'claude-settings' },
    { kind: 'skill-backing', id: 'claude-skills', action: 'initialize' },
  ],
} satisfies Pick<
  ProviderHostContract,
  'projectDocument' | 'stateVolumes' | 'skillBackings' | 'skillViews' | 'files' | 'groupInitOperations'
>;

registerProviderHostContract('claude', {
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  spawnOperations: [
    { kind: 'legacy-overlay' },
    { kind: 'skill-backing', id: 'claude-skills', action: 'sync' },
    { kind: 'project-document' },
  ],
  // The built-in declaration contributes no env. The existing conditional
  // src/providers/claude.ts adapter remains the custom-endpoint overlay, so
  // the adapter is optional rather than required.
  environment: 'none',
  legacyHostAdapter: 'optional',
  commands: {
    nativeAdmin: ['/compact', '/context', '/cost', '/files'],
    nativeFiltered: ['/start', '/help', '/login', '/logout', '/doctor', '/config', '/remote-control'],
  },
});
