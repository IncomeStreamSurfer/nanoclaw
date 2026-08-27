import { CODEX_PROJECT_DOC_MAX_BYTES } from '../providers/codex-agents-md.js';

import { registerProviderHostContract } from './registry.js';

registerProviderHostContract('codex', {
  projectDocument: {
    fileName: 'AGENTS.md',
    maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
    // Instruction prose is core-owned canon; Codex declares only the facts
    // rendered into it. No sourceProtection: the canonical template is
    // protected through the Claude declaration.
    instructions: {
      nativeOverrideFiles: ['AGENTS.local.md', 'AGENTS.override.md'],
      nativeSkills: {
        discoveryPath: '/workspace/agent/.agents/skills',
        sharedSource: '/app/skills',
        selfAuthoredHome: '~/.codex/skills',
        persistentRoots: ['~/.codex', '~/.agents'],
        ruleBearingInlined: true,
      },
    },
  },
  stateVolumes: [
    {
      id: 'codex-home',
      directory: '.codex-shared',
      containerPath: '/home/node/.codex',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    {
      id: 'codex-skills',
      location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      sharedLinks: { prune: 'symlinks-only' },
      templateCopies: 'copy',
    },
  ],
  skillViews: [
    {
      backingId: 'codex-skills',
      containerPath: '/workspace/agent/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
      mount: 'bind',
    },
    {
      backingId: 'codex-skills',
      containerPath: '/home/node/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
      mount: 'bind',
    },
  ],
  groupInitOperations: [],
  spawnOperations: [
    { kind: 'state-volume', id: 'codex-home' },
    { kind: 'prepared-file', id: 'codex-auth-stub' },
    { kind: 'project-document' },
    { kind: 'skill-backing', id: 'codex-skills', action: 'sync' },
    { kind: 'legacy-overlay' },
  ],
  files: [
    {
      id: 'codex-auth-stub',
      volumeId: 'codex-home',
      relativePath: 'auth.json',
      prepare: { operation: 'append-open-close', when: 'every-spawn', mode: 'process-default' },
      // The gateway owns auth.json content; the host only ensures the
      // mountpoint exists, so there is nothing to reconcile.
      contentOwner: 'gateway',
    },
  ],
  environment: 'none',
  legacyHostAdapter: 'required',
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
