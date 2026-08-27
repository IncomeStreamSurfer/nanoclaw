import { describe, expect, it } from 'vitest';

import './index.js';
import {
  getProviderHostContract,
  hasDeclaredProviderContract,
  listProviderHostContractNames,
  registerProviderHostContract,
  type ProviderHostContract,
} from './registry.js';

function emptyContract(): ProviderHostContract {
  return {
    stateVolumes: [],
    skillBackings: [],
    skillViews: [],
    files: [],
    groupInitOperations: [],
    spawnOperations: [{ kind: 'legacy-overlay' }],
    environment: 'none',
    legacyHostAdapter: 'optional',
    commands: { nativeAdmin: [], nativeFiltered: [] },
  };
}

const missing = Symbol('missing');

/** Deep clone that carries contract functions (transforms) by reference. */
function cloneContract<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneContract(entry)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneContract(entry)])) as T;
  }
  return value;
}

function claudeContractWith(path: string, value: unknown | typeof missing): ProviderHostContract {
  const contract = cloneContract(getProviderHostContract('claude')!);
  const parts = path.split('.');
  let target = contract as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const field = parts.at(-1)!;
  if (value === missing) delete target[field];
  else target[field] = value;
  return contract;
}

function contractName(field: string, suffix: string): string {
  return `invalid-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

describe('provider host contracts', () => {
  it('loads the complete Claude base declaration from the separate contract barrel', () => {
    const contract = getProviderHostContract('claude');

    expect(contract).toBeDefined();
    expect(contract?.projectDocument).toMatchObject({
      fileName: 'CLAUDE.md',
      containerPath: '/workspace/agent/CLAUDE.md',
      sourceProtection: 'install-surface',
    });
    expect(contract?.stateVolumes).toEqual([
      expect.objectContaining({ id: 'claude-home', directory: '.claude-shared', scope: 'group' }),
    ]);
    expect(contract?.skillBackings).toEqual([
      expect.objectContaining({ id: 'claude-skills', templateCopies: 'in-place' }),
    ]);
    expect(contract?.files).toEqual([
      expect.objectContaining({
        id: 'claude-settings',
        contentOwner: 'provider',
        reconcile: expect.objectContaining({ when: 'group-init', write: 'atomic-replace' }),
      }),
    ]);
    expect(typeof contract?.files[0]?.reconcile?.transform.transform).toBe('function');
    expect(typeof contract?.files[0]?.reconcile?.transform.mapIoFailure).toBe('function');
    expect(contract?.environment).toBe('none');
    expect(contract?.legacyHostAdapter).toBe('optional');
    expect(contract?.commands.nativeFiltered).toContain('/remote-control');
  });

  it('keeps provider lookup case-insensitive and unknown providers undeclared', () => {
    expect(hasDeclaredProviderContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderContract('not-installed')).toBe(false);
    expect(listProviderHostContractNames()).toContain('claude');
  });

  it('rejects duplicate declarations at registration', () => {
    const name = `duplicate-contract-${process.pid}`;
    const empty = emptyContract();
    registerProviderHostContract(name, empty);
    expect(() => registerProviderHostContract(name, empty)).toThrow(/already registered/);
  });

  it('freezes the stored contract so later mutation attempts throw', () => {
    const name = `immutable-contract-${process.pid}`;
    registerProviderHostContract(name, emptyContract());

    const stored = getProviderHostContract(name)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands.nativeAdmin)).toBe(true);
    expect(() => (stored.commands.nativeAdmin as string[]).push('/later')).toThrow();
  });

  it.each([
    [
      'host path',
      () => ({
        ...emptyContract(),
        projectDocument: {
          fileName: 'AGENTS.md',
          baseDocumentFile: '/tmp/AGENTS.md',
          containerPath: '/workspace/agent/AGENTS.md',
          mountClass: 'group-state' as const,
        },
        spawnOperations: [{ kind: 'project-document' as const }, { kind: 'legacy-overlay' as const }],
      }),
      /one file or directory name/,
    ],
    [
      'duplicate volume identity',
      () => ({
        ...emptyContract(),
        stateVolumes: [
          {
            id: 'state',
            directory: '.one',
            containerPath: '/one',
            scope: 'group' as const,
            mode: 'rw' as const,
            mountClass: 'group-state' as const,
          },
          {
            id: 'state',
            directory: '.two',
            containerPath: '/two',
            scope: 'session' as const,
            mode: 'rw' as const,
            mountClass: 'allowlisted-extra' as const,
          },
        ],
      }),
      /must be unique/,
    ],
    [
      'missing backing volume',
      () => ({
        ...emptyContract(),
        skillBackings: [
          {
            id: 'skills',
            location: { kind: 'state-volume' as const, volumeId: 'missing', subdirectory: 'skills' },
            skillsSubdirectory: 'skills',
            conflictDiagnostics: 'silent' as const,
            templateCopies: 'in-place' as const,
          },
        ],
      }),
      /references unknown/,
    ],
  ])('rejects %s at registration', (_label, makeContract, expected) => {
    const name = `invalid-${_label.toLowerCase().replaceAll(' ', '-')}-${process.pid}`;
    expect(() => registerProviderHostContract(name, makeContract())).toThrow(expected);
  });

  it.each([
    ['not an array', {}, /projectDocument\.extraSections must be an array/],
    ['missing name', [{ body: 'body' }], /extraSections\[0\]\.name must be a non-empty string/],
    ['missing body', [{ name: 'name' }], /extraSections\[0\]\.body must be a non-empty string/],
    ['blank name', [{ name: ' ', body: 'body' }], /extraSections\[0\]\.name must be a non-empty string/],
    ['blank body', [{ name: 'name', body: ' ' }], /extraSections\[0\]\.body must be a non-empty string/],
  ])('rejects malformed project-document extra sections: %s', (_label, value, expected) => {
    expect(() =>
      registerProviderHostContract(
        contractName(`extra-sections-${_label}`, 'invalid'),
        claudeContractWith('projectDocument.extraSections', value),
      ),
    ).toThrow(expected);
  });

  it.each(['stateVolumes', 'skillBackings', 'skillViews', 'files', 'groupInitOperations', 'spawnOperations'])(
    'requires top-level host array %s',
    (field) => {
      expect(() =>
        registerProviderHostContract(contractName(`array-${field}`, 'wrong'), claudeContractWith(field, {})),
      ).toThrow(`.${field} must be an array`);
      expect(() =>
        registerProviderHostContract(contractName(`array-${field}`, 'missing'), claudeContractWith(field, missing)),
      ).toThrow(`.${field} must be an array`);
    },
  );

  it.each([
    ['projectDocument.mountClass', 'claude.projectDocument.mountClass'],
    ['projectDocument.sourceProtection', 'claude.projectDocument.sourceProtection'],
    ['stateVolumes.0.scope', 'claude.stateVolumes.claude-home.scope'],
    ['stateVolumes.0.mode', 'claude.stateVolumes.claude-home.mode'],
    ['stateVolumes.0.mountClass', 'claude.stateVolumes.claude-home.mountClass'],
    ['skillBackings.0.location.kind', 'claude.skillBackings.claude-skills.location.kind'],
    ['skillBackings.0.sharedLinks.prune', 'claude.skillBackings.claude-skills.sharedLinks.prune'],
    ['skillBackings.0.conflictDiagnostics', 'claude.skillBackings.claude-skills.conflictDiagnostics'],
    ['skillBackings.0.templateCopies', 'claude.skillBackings.claude-skills.templateCopies'],
    ['skillViews.0.mode', 'claude.skillViews.claude-skills.mode'],
    ['skillViews.0.mountClass', 'claude.skillViews.claude-skills.mountClass'],
    ['skillViews.0.mount', 'claude.skillViews.claude-skills.mount'],
    ['files.0.prepare.operation', 'claude.files.claude-settings.prepare.operation'],
    ['files.0.prepare.when', 'claude.files.claude-settings.prepare.when'],
    ['files.0.prepare.mode', 'claude.files.claude-settings.prepare.mode'],
    ['files.0.contentOwner', 'claude.files.claude-settings.contentOwner'],
    ['files.0.reconcile.when', 'claude.files.claude-settings.reconcile.when'],
    ['files.0.reconcile.write', 'claude.files.claude-settings.reconcile.write'],
    ['groupInitOperations.0.kind', 'claude.group-initOperations[].kind'],
    ['groupInitOperations.2.action', 'claude.group-initOperations.skill-backing.action'],
    ['commands.nativeAdmin', 'claude.commands.nativeAdmin'],
    ['commands.nativeFiltered', 'claude.commands.nativeFiltered'],
  ])('rejects invalid %s at registration', (path, field) => {
    expect(() =>
      registerProviderHostContract(contractName(path, 'invalid'), claudeContractWith(path, 'invalid')),
    ).toThrow(field.slice('claude'.length));
  });

  it.each([
    ['environment', 'claude.environment'],
    ['legacyHostAdapter', 'claude.legacyHostAdapter'],
  ])('rejects invalid and missing %s at registration', (path, field) => {
    expect(() =>
      registerProviderHostContract(contractName(path, 'invalid'), claudeContractWith(path, 'invalid')),
    ).toThrow(field.slice('claude'.length));
    expect(() =>
      registerProviderHostContract(contractName(path, 'missing'), claudeContractWith(path, missing)),
    ).toThrow(field.slice('claude'.length));
  });

  it('rejects reconcile declarations without callable transforms', () => {
    expect(() =>
      registerProviderHostContract(
        contractName('reconcile-transform', 'invalid'),
        claudeContractWith('files.0.reconcile.transform', {}),
      ),
    ).toThrow(/reconcile\.transform\.transform must be a function/);
    expect(() =>
      registerProviderHostContract(
        contractName('reconcile-map-io', 'invalid'),
        claudeContractWith('files.0.reconcile.transform.mapIoFailure', 'invalid'),
      ),
    ).toThrow(/reconcile\.transform\.mapIoFailure must be a function/);
  });

  it("requires the legacy host adapter when environment uses 'legacy-overlay'", () => {
    expect(() =>
      registerProviderHostContract(contractName('legacy-overlay-adapter', 'optional'), {
        ...emptyContract(),
        environment: 'legacy-overlay',
      }),
    ).toThrow(/environment 'legacy-overlay' requires legacyHostAdapter 'required'/);
  });

  it('rejects invalid prepared-file ownership, content, and reconciliation', () => {
    expect(() =>
      registerProviderHostContract(
        contractName('prepare-content', 'missing'),
        claudeContractWith('files.0.prepare.content', missing),
      ),
    ).toThrow(/files\.claude-settings\.prepare\.content/);
    expect(() =>
      registerProviderHostContract(
        contractName('create-owner', 'gateway'),
        claudeContractWith('files.0.contentOwner', 'gateway'),
      ),
    ).toThrow(/contentOwner must be 'provider' for create-if-missing/);

    const appendProvider = claudeContractWith('files.0.prepare', {
      operation: 'append-open-close',
      when: 'every-spawn',
      mode: 'process-default',
    });
    appendProvider.files[0].contentOwner = 'provider';
    delete (appendProvider.files[0] as { reconcile?: unknown }).reconcile;
    expect(() => registerProviderHostContract(contractName('append-owner', 'provider'), appendProvider)).toThrow(
      /contentOwner must be 'gateway' for append-open-close/,
    );

    const appendReconcile = claudeContractWith('files.0.prepare', {
      operation: 'append-open-close',
      when: 'every-spawn',
      mode: 'process-default',
    });
    appendReconcile.files[0].contentOwner = 'gateway';
    expect(() => registerProviderHostContract(contractName('append-reconcile', 'kept'), appendReconcile)).toThrow(
      /reconcile must be omitted for append-open-close/,
    );

    expect(() =>
      registerProviderHostContract(
        contractName('reconcile-when', 'mismatch'),
        claudeContractWith('files.0.reconcile.when', 'every-spawn'),
      ),
    ).toThrow(/reconcile\.when must match prepare\.when/);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['too-large', 0o10000],
  ])('rejects invalid numeric prepared-file mode %s', (label, mode) => {
    expect(() =>
      registerProviderHostContract(
        contractName('prepare-mode', label),
        claudeContractWith('files.0.prepare.mode', mode),
      ),
    ).toThrow(/prepare\.mode must be 'process-default' or an integer from 0 to 0o7777/);
  });

  it.each([
    [
      'prepared file',
      [
        { kind: 'prepared-file', id: 'claude-settings' },
        { kind: 'state-volume', id: 'claude-home' },
        { kind: 'skill-backing', id: 'claude-skills', action: 'initialize' },
      ],
      /prepared-file 'claude-settings' must follow state-volume 'claude-home'/,
    ],
    [
      'skill backing',
      [
        { kind: 'skill-backing', id: 'claude-skills', action: 'initialize' },
        { kind: 'state-volume', id: 'claude-home' },
        { kind: 'prepared-file', id: 'claude-settings' },
      ],
      /skill-backing 'claude-skills' must follow state-volume 'claude-home'/,
    ],
  ])('rejects %s before its lifecycle volume', (_label, operations, expected) => {
    expect(() =>
      registerProviderHostContract(
        contractName(`operation-order-${_label}`, 'invalid'),
        claudeContractWith('groupInitOperations', operations),
      ),
    ).toThrow(expected);
  });

  it.each([
    ['prepared-file', { kind: 'prepared-file', id: 'claude-settings' }, /prepared-file 'claude-settings'/],
    [
      'skill-backing',
      { kind: 'skill-backing', id: 'claude-skills', action: 'initialize' },
      /skill-backing 'claude-skills'/,
    ],
  ])('does not let group-init %s rely on a volume moved to spawn', (_label, dependent, expected) => {
    const contract = claudeContractWith('groupInitOperations', [
      dependent,
      ...(dependent.kind === 'prepared-file'
        ? [{ kind: 'skill-backing', id: 'claude-skills', action: 'initialize' }]
        : [{ kind: 'prepared-file', id: 'claude-settings' }]),
    ]);
    contract.spawnOperations = [{ kind: 'state-volume', id: 'claude-home' }, ...contract.spawnOperations];
    expect(() => registerProviderHostContract(contractName(`cross-phase-${_label}`, 'invalid'), contract)).toThrow(
      expected,
    );
  });

  it('requires a session-volume dependent to follow its spawn volume', () => {
    const contract = claudeContractWith('stateVolumes', [
      ...cloneContract(getProviderHostContract('claude')!.stateVolumes),
      {
        id: 'session-state',
        directory: 'session-state',
        containerPath: '/session-state',
        scope: 'session',
        mode: 'rw',
        mountClass: 'allowlisted-extra',
      },
    ]);
    contract.files = [
      ...contract.files,
      {
        id: 'session-file',
        volumeId: 'session-state',
        relativePath: 'state.json',
        prepare: { operation: 'append-open-close', when: 'every-spawn', mode: 0o600 },
        contentOwner: 'gateway',
      },
    ];
    contract.spawnOperations = [
      { kind: 'prepared-file', id: 'session-file' },
      { kind: 'state-volume', id: 'session-state' },
      ...contract.spawnOperations,
    ];
    expect(() => registerProviderHostContract(contractName('session-volume-order', 'invalid'), contract)).toThrow(
      /prepared-file 'session-file' must follow state-volume 'session-state'/,
    );
  });

  it('requires an allowlisted mount to have an explicit spawn position', () => {
    const contract = claudeContractWith('stateVolumes', [
      ...cloneContract(getProviderHostContract('claude')!.stateVolumes),
      {
        id: 'late-only',
        directory: 'late-only',
        containerPath: '/late-only',
        scope: 'group',
        mode: 'rw',
        mountClass: 'allowlisted-extra',
      },
    ]);
    contract.groupInitOperations = [{ kind: 'state-volume', id: 'late-only' }, ...contract.groupInitOperations];

    expect(() => registerProviderHostContract(contractName('allowlisted-spawn-order', 'invalid'), contract)).toThrow(
      /allowlisted-extra mount 'state-volume:late-only' must appear in spawnOperations/,
    );
  });

  it.each([
    [
      'non-state backing',
      'skillBackings.0.location',
      { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      /requires a state-volume backing/,
    ],
    [
      'wrong destination',
      'skillViews.0.containerPath',
      '/home/node/.claude/other',
      /containerPath must be .* for parent-volume/,
    ],
    ['wrong mode', 'skillViews.0.mode', 'ro', /mode must match parent volume/],
    ['wrong mount class', 'skillViews.0.mountClass', 'allowlisted-extra', /mountClass must match parent volume/],
  ])('rejects unrealizable parent-volume view: %s', (_label, field, value, expected) => {
    expect(() =>
      registerProviderHostContract(
        contractName(`parent-volume-${_label}`, 'invalid'),
        claudeContractWith(field, value),
      ),
    ).toThrow(expected);
  });

  it.each([
    [
      'container path alias',
      'stateVolumes.0.containerPath',
      '/home/node//.claude',
      /canonical absolute container path/,
    ],
    ['relative dot alias', 'files.0.relativePath', './settings.json', /canonical relative path/],
    ['relative parent alias', 'files.0.relativePath', 'config/../settings.json', /canonical relative path/],
    ['leading relative parent', 'files.0.relativePath', '../settings.json', /canonical relative path/],
    ['backing relative parent', 'skillBackings.0.location.subdirectory', '../skills', /canonical relative path/],
    ['skills relative parent', 'skillBackings.0.skillsSubdirectory', '../skills', /canonical relative path/],
    ['relative slash alias', 'files.0.relativePath', 'config//settings.json', /canonical relative path/],
  ])('rejects noncanonical %s', (_label, field, value, expected) => {
    expect(() =>
      registerProviderHostContract(contractName(`path-${_label}`, 'invalid'), claudeContractWith(field, value)),
    ).toThrow(expected);
  });
});
