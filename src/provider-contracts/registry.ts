/**
 * Host-side provider surface contracts.
 *
 * Provider payloads name container-visible files and directories. They never
 * name host paths; the host realization resolves those from scope and group.
 * Every declared surface is executed by the realization (group-init and
 * spawn), and file reconciliation carries its transformer function directly —
 * a declared behavior with no implementation cannot register.
 *
 * This registry is separate from src/providers/index.ts so contract imports do
 * not change provider identity detection used by update-skills.
 */

import path from 'path';

import type { ProviderInstructionFacts } from '../project-doc-compose.js';
import { listProviderContainerConfigNames } from '../providers/provider-container-registry.js';

export interface ProviderProjectDocument {
  fileName: string;
  /**
   * Typed variables for core's canonical instruction template. The prose is
   * core-owned; a provider declares only paths, filenames, and flags.
   */
  instructions?: ProviderInstructionFacts;
  maxBytes?: number;
  /** Destination inside the agent container. */
  containerPath: string;
  /** Current effective admission class; declarations do not repair it. */
  mountClass: 'group-state' | 'allowlisted-extra';
  /** Present when the canonical instruction template remains an install-surface policy root. */
  sourceProtection?: 'install-surface';
}

export interface ProviderStateVolume {
  /** Stable identity used by files and skill backings. */
  id: string;
  /** Existing provider-owned directory name; never a host path. */
  directory: string;
  containerPath: string;
  scope: 'group' | 'session';
  mode: 'ro' | 'rw';
  /** Current effective admission class; declarations do not repair it. */
  mountClass: 'group-state' | 'allowlisted-extra';
}

export type ProviderSkillBackingLocation =
  | { kind: 'state-volume'; volumeId: string; subdirectory: string }
  | { kind: 'group-directory'; directory: string; subdirectory: string };

export interface ProviderSkillBacking {
  id: string;
  /** Backing root mounted by every view. */
  location: ProviderSkillBackingLocation;
  /** Provider-native skills directory below the backing root. */
  skillsSubdirectory: string;
  /** Present when core syncs shared skill symlinks into the backing. */
  sharedLinks?: { prune: 'symlinks-only' };
  conflictDiagnostics: 'warn' | 'silent';
  templateCopies: 'in-place' | 'copy';
}

export interface ProviderSkillView {
  backingId: string;
  containerPath: string;
  mode: 'ro' | 'rw';
  mountClass: 'group-state' | 'allowlisted-extra';
  /** A parent state mount can already expose the view without another bind. */
  mount: 'parent-volume' | 'bind';
}

export interface ProviderFileDiagnostic {
  level: 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

export type ProviderFileTransformResult =
  | { kind: 'unchanged'; diagnostics?: readonly ProviderFileDiagnostic[] }
  | { kind: 'replace'; content: string; diagnostics?: readonly ProviderFileDiagnostic[] };

export interface ProviderFileTransformer {
  transform(current: string, filePath: string): ProviderFileTransformResult;
  mapIoFailure(error: unknown, filePath: string): ProviderFileDiagnostic;
}

export interface ProviderPreparedFile {
  id: string;
  volumeId: string;
  relativePath: string;
  prepare:
    | { operation: 'create-if-missing'; when: 'group-init'; content: string; mode: 'process-default' | number }
    | { operation: 'append-open-close'; when: 'every-spawn'; mode: 'process-default' | number };
  contentOwner: 'provider' | 'gateway';
  /** Present when core reconciles existing file content; absent for gateway-owned files. */
  reconcile?: {
    transform: ProviderFileTransformer;
    /** Names whose settings the reconciliation log line reports; defaults to the contract's provider. */
    transformerProvider?: string;
    when: 'group-init' | 'every-spawn';
    write: 'atomic-replace';
  };
}

export type ProviderHostOperation =
  | { kind: 'state-volume'; id: string }
  | { kind: 'prepared-file'; id: string }
  | { kind: 'skill-backing'; id: string; action: 'initialize' | 'sync' }
  | { kind: 'project-document' }
  | { kind: 'legacy-overlay' };

export interface ProviderHostContract {
  /** Absent when the provider ships no core-composed project document. */
  projectDocument?: ProviderProjectDocument;
  stateVolumes: readonly ProviderStateVolume[];
  skillBackings: readonly ProviderSkillBacking[];
  skillViews: readonly ProviderSkillView[];
  files: readonly ProviderPreparedFile[];
  /** Ordered group-creation operations. */
  groupInitOperations: readonly ProviderHostOperation[];
  /** Ordered pre-spawn operations, including the legacy env adapter handoff. */
  spawnOperations: readonly ProviderHostOperation[];
  /** Whether legacy callbacks still contribute environment during migration. */
  environment: 'legacy-overlay' | 'none';
  /** Whether the mixed-version compatibility adapter must be registered. */
  legacyHostAdapter: 'required' | 'optional';
  commands: {
    nativeAdmin: readonly string[];
    nativeFiltered: readonly string[];
  };
}

const registry = new Map<string, ProviderHostContract>();

export function registerProviderHostContract(name: string, contract: ProviderHostContract): void {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider host contract name must be lowercase kebab-case: '${name}'`);
  }
  if (registry.has(key)) throw new Error(`Provider host contract already registered: ${key}`);
  validateProviderHostContract(key, contract);
  registry.set(key, deepFreeze(contract));
}

export function getProviderHostContract(name: string | null | undefined): ProviderHostContract | undefined {
  return name ? registry.get(name.toLowerCase()) : undefined;
}

export function hasDeclaredProviderContract(name: string | null | undefined): boolean {
  return getProviderHostContract(name) !== undefined;
}

export function listProviderHostContractNames(): string[] {
  return [...registry.keys()];
}

export function listProviderHostContracts(): readonly ProviderHostContract[] {
  return [...registry.values()];
}

export function assertProviderHostConformance(): void {
  const registered = new Set(listProviderContainerConfigNames());
  for (const [provider, contract] of registry) {
    if (contract.legacyHostAdapter === 'required' && !registered.has(provider)) {
      throw new Error(`Provider '${provider}' host contract requires a legacy host adapter`);
    }
  }
}

function validateProviderHostContract(provider: string, contract: ProviderHostContract): void {
  for (const field of [
    'stateVolumes',
    'skillBackings',
    'skillViews',
    'files',
    'groupInitOperations',
    'spawnOperations',
  ] as const) {
    assertArray(contract[field], `${provider}.${field}`);
  }
  assertAllowed(contract.environment, ['legacy-overlay', 'none'], `${provider}.environment`);
  assertAllowed(contract.legacyHostAdapter, ['required', 'optional'], `${provider}.legacyHostAdapter`);
  if (contract.environment === 'legacy-overlay' && contract.legacyHostAdapter !== 'required') {
    throw new Error(`${provider}.environment 'legacy-overlay' requires legacyHostAdapter 'required'`);
  }
  assertCommandArray(contract.commands?.nativeAdmin, `${provider}.commands.nativeAdmin`);
  assertCommandArray(contract.commands?.nativeFiltered, `${provider}.commands.nativeFiltered`);
  unique(contract.commands.nativeAdmin, `${provider}.commands.nativeAdmin`);
  unique(contract.commands.nativeFiltered, `${provider}.commands.nativeFiltered`);

  const volumeIds = unique(
    contract.stateVolumes.map((volume) => volume.id),
    `${provider}.stateVolumes[].id`,
  );
  const backingIds = unique(
    contract.skillBackings.map((backing) => backing.id),
    `${provider}.skillBackings[].id`,
  );
  unique(
    contract.files.map((file) => file.id),
    `${provider}.files[].id`,
  );

  const destinations: string[] = [];
  if (contract.projectDocument !== undefined) {
    const doc = contract.projectDocument;
    if (doc === null || typeof doc !== 'object') throw new Error(`${provider}.projectDocument must be an object`);
    assertFileName(doc.fileName, `${provider}.projectDocument.fileName`);
    assertContainerPath(doc.containerPath, `${provider}.projectDocument.containerPath`);
    assertAllowed(doc.mountClass, ['group-state', 'allowlisted-extra'], `${provider}.projectDocument.mountClass`);
    if (doc.instructions !== undefined) {
      const facts = doc.instructions;
      if (facts === null || typeof facts !== 'object') {
        throw new Error(`${provider}.projectDocument.instructions must be an object`);
      }
      if (facts.nativeOverrideFiles !== undefined) {
        if (!Array.isArray(facts.nativeOverrideFiles) || facts.nativeOverrideFiles.length === 0) {
          throw new Error(`${provider}.projectDocument.instructions.nativeOverrideFiles must be a non-empty array`);
        }
        for (const file of facts.nativeOverrideFiles) {
          assertFileName(file, `${provider}.projectDocument.instructions.nativeOverrideFiles[]`);
        }
      }
      if (facts.nativeSkills !== undefined) {
        const skills = facts.nativeSkills;
        assertContainerPath(
          skills?.discoveryPath,
          `${provider}.projectDocument.instructions.nativeSkills.discoveryPath`,
        );
        assertContainerPath(skills.sharedSource, `${provider}.projectDocument.instructions.nativeSkills.sharedSource`);
        assertNonEmptyString(
          skills.selfAuthoredHome,
          `${provider}.projectDocument.instructions.nativeSkills.selfAuthoredHome`,
        );
        if (!Array.isArray(skills.persistentRoots) || skills.persistentRoots.length === 0) {
          throw new Error(
            `${provider}.projectDocument.instructions.nativeSkills.persistentRoots must be a non-empty array`,
          );
        }
        for (const root of skills.persistentRoots) {
          assertNonEmptyString(root, `${provider}.projectDocument.instructions.nativeSkills.persistentRoots[]`);
        }
      }
    }
    if (doc.maxBytes !== undefined && (!Number.isInteger(doc.maxBytes) || doc.maxBytes <= 0)) {
      throw new Error(`${provider}.projectDocument.maxBytes must be a positive integer`);
    }
    if (doc.sourceProtection !== undefined) {
      assertAllowed(doc.sourceProtection, ['install-surface'], `${provider}.projectDocument.sourceProtection`);
    }
    destinations.push(doc.containerPath);
  }

  for (const volume of contract.stateVolumes) {
    assertName(volume.id, `${provider}.stateVolumes.${volume.id}.id`);
    assertFileName(volume.directory, `${provider}.stateVolumes.${volume.id}.directory`);
    assertContainerPath(volume.containerPath, `${provider}.stateVolumes.${volume.id}.containerPath`);
    assertAllowed(volume.scope, ['group', 'session'], `${provider}.stateVolumes.${volume.id}.scope`);
    assertAllowed(volume.mode, ['ro', 'rw'], `${provider}.stateVolumes.${volume.id}.mode`);
    assertAllowed(
      volume.mountClass,
      ['group-state', 'allowlisted-extra'],
      `${provider}.stateVolumes.${volume.id}.mountClass`,
    );
    destinations.push(volume.containerPath);
  }

  for (const backing of contract.skillBackings) {
    assertName(backing.id, `${provider}.skillBackings.${backing.id}.id`);
    assertAllowed(
      backing.location?.kind,
      ['state-volume', 'group-directory'],
      `${provider}.skillBackings.${backing.id}.location.kind`,
    );
    if (backing.sharedLinks !== undefined) {
      assertAllowed(
        backing.sharedLinks?.prune,
        ['symlinks-only'],
        `${provider}.skillBackings.${backing.id}.sharedLinks.prune`,
      );
    }
    assertAllowed(
      backing.conflictDiagnostics,
      ['warn', 'silent'],
      `${provider}.skillBackings.${backing.id}.conflictDiagnostics`,
    );
    assertAllowed(
      backing.templateCopies,
      ['in-place', 'copy'],
      `${provider}.skillBackings.${backing.id}.templateCopies`,
    );
    assertRelativePath(backing.location.subdirectory, `${provider}.skillBackings.${backing.id}.subdirectory`, true);
    assertRelativePath(backing.skillsSubdirectory, `${provider}.skillBackings.${backing.id}.skillsSubdirectory`);
    if (backing.location.kind === 'state-volume') {
      assertReference(volumeIds, backing.location.volumeId, `${provider}.skillBackings.${backing.id}.volumeId`);
    } else {
      assertFileName(backing.location.directory, `${provider}.skillBackings.${backing.id}.directory`);
    }
  }

  for (const view of contract.skillViews) {
    assertReference(backingIds, view.backingId, `${provider}.skillViews[].backingId`);
    assertContainerPath(view.containerPath, `${provider}.skillViews.${view.backingId}.containerPath`);
    assertAllowed(view.mode, ['ro', 'rw'], `${provider}.skillViews.${view.backingId}.mode`);
    assertAllowed(
      view.mountClass,
      ['group-state', 'allowlisted-extra'],
      `${provider}.skillViews.${view.backingId}.mountClass`,
    );
    assertAllowed(view.mount, ['parent-volume', 'bind'], `${provider}.skillViews.${view.backingId}.mount`);
    if (view.mount === 'parent-volume') {
      const backing = contract.skillBackings.find((candidate) => candidate.id === view.backingId)!;
      const location = backing.location;
      if (location.kind !== 'state-volume') {
        throw new Error(`${provider}.skillViews.${view.backingId}.mount parent-volume requires a state-volume backing`);
      }
      const volume = contract.stateVolumes.find((candidate) => candidate.id === location.volumeId)!;
      const expectedPath = path.posix.join(volume.containerPath, location.subdirectory, backing.skillsSubdirectory);
      if (view.containerPath !== expectedPath) {
        throw new Error(
          `${provider}.skillViews.${view.backingId}.containerPath must be '${expectedPath}' for parent-volume`,
        );
      }
      if (view.mode !== volume.mode) {
        throw new Error(`${provider}.skillViews.${view.backingId}.mode must match parent volume '${volume.id}'`);
      }
      if (view.mountClass !== volume.mountClass) {
        throw new Error(`${provider}.skillViews.${view.backingId}.mountClass must match parent volume '${volume.id}'`);
      }
    }
    if (view.mount === 'bind') destinations.push(view.containerPath);
  }

  for (const file of contract.files) {
    assertName(file.id, `${provider}.files.${file.id}.id`);
    assertReference(volumeIds, file.volumeId, `${provider}.files.${file.id}.volumeId`);
    assertRelativePath(file.relativePath, `${provider}.files.${file.id}.relativePath`);
    assertAllowed(
      file.prepare?.operation,
      ['create-if-missing', 'append-open-close'],
      `${provider}.files.${file.id}.prepare.operation`,
    );
    assertAllowed(
      file.prepare.when,
      file.prepare.operation === 'create-if-missing' ? ['group-init'] : ['every-spawn'],
      `${provider}.files.${file.id}.prepare.when`,
    );
    if (
      file.prepare.mode !== 'process-default' &&
      (!Number.isInteger(file.prepare.mode) || file.prepare.mode < 0 || file.prepare.mode > 0o7777)
    ) {
      throw new Error(
        `${provider}.files.${file.id}.prepare.mode must be 'process-default' or an integer from 0 to 0o7777`,
      );
    }
    assertAllowed(file.contentOwner, ['provider', 'gateway'], `${provider}.files.${file.id}.contentOwner`);
    if (file.prepare.operation === 'create-if-missing') {
      if (typeof file.prepare.content !== 'string') {
        throw new Error(`${provider}.files.${file.id}.prepare.content must be a string`);
      }
      if (file.contentOwner !== 'provider') {
        throw new Error(`${provider}.files.${file.id}.contentOwner must be 'provider' for create-if-missing`);
      }
    } else {
      if (file.contentOwner !== 'gateway') {
        throw new Error(`${provider}.files.${file.id}.contentOwner must be 'gateway' for append-open-close`);
      }
      if (file.reconcile !== undefined) {
        throw new Error(`${provider}.files.${file.id}.reconcile must be omitted for append-open-close`);
      }
    }
    if (file.reconcile !== undefined) {
      if (typeof file.reconcile.transform?.transform !== 'function') {
        throw new Error(`${provider}.files.${file.id}.reconcile.transform.transform must be a function`);
      }
      if (typeof file.reconcile.transform.mapIoFailure !== 'function') {
        throw new Error(`${provider}.files.${file.id}.reconcile.transform.mapIoFailure must be a function`);
      }
      if (file.reconcile.transformerProvider !== undefined) {
        assertName(file.reconcile.transformerProvider, `${provider}.files.${file.id}.reconcile.transformerProvider`);
      }
      assertAllowed(file.reconcile.when, ['group-init', 'every-spawn'], `${provider}.files.${file.id}.reconcile.when`);
      assertAllowed(file.reconcile.write, ['atomic-replace'], `${provider}.files.${file.id}.reconcile.write`);
      if (file.reconcile.when !== file.prepare.when) {
        throw new Error(`${provider}.files.${file.id}.reconcile.when must match prepare.when`);
      }
    }
  }

  const groupInitVolumeIds = new Set(
    contract.groupInitOperations
      .filter((operation) => operation.kind === 'state-volume')
      .map((operation) => operation.id),
  );
  const groupInitOperations = validateOperations(
    provider,
    'group-init',
    contract.groupInitOperations,
    volumeIds,
    backingIds,
    contract,
  );
  const spawnOperations = validateOperations(
    provider,
    'every-spawn',
    contract.spawnOperations,
    volumeIds,
    backingIds,
    contract,
    groupInitVolumeIds,
  );
  const operations = [...groupInitOperations, ...spawnOperations];
  for (const volume of contract.stateVolumes) requireOperation(operations, `state-volume:${volume.id}`, provider);
  for (const file of contract.files) requireOperation(operations, `prepared-file:${file.id}`, provider);
  for (const backing of contract.skillBackings) requireOperation(operations, `skill-backing:${backing.id}`, provider);
  if (contract.projectDocument !== undefined) requireOperation(operations, 'project-document', provider);
  requireOperation(operations, 'legacy-overlay', provider);
  for (const volume of contract.stateVolumes) {
    if (volume.mountClass === 'allowlisted-extra') {
      requireSpawnOperation(spawnOperations, `state-volume:${volume.id}`, provider);
    }
  }
  for (const view of contract.skillViews) {
    if (view.mount === 'bind' && view.mountClass === 'allowlisted-extra') {
      requireSpawnOperation(spawnOperations, `skill-backing:${view.backingId}`, provider);
    }
  }

  unique(destinations, `${provider} container destinations`);
}

function validateOperations(
  provider: string,
  phase: 'group-init' | 'every-spawn',
  operations: readonly ProviderHostOperation[],
  volumeIds: ReadonlySet<string>,
  backingIds: ReadonlySet<string>,
  contract: ProviderHostContract,
  availableVolumeIds: ReadonlySet<string> = new Set(),
): string[] {
  const initializedVolumeIds = new Set(availableVolumeIds);
  const keys = operations.map((operation) => {
    assertAllowed(
      operation?.kind,
      ['state-volume', 'prepared-file', 'skill-backing', 'project-document', 'legacy-overlay'],
      `${provider}.${phase}Operations[].kind`,
    );
    if (operation.kind === 'state-volume') {
      assertReference(volumeIds, operation.id, `${provider}.${phase}Operations.state-volume`);
      const volume = contract.stateVolumes.find((candidate) => candidate.id === operation.id)!;
      if (phase === 'group-init' && volume.scope !== 'group') {
        throw new Error(`${provider}.group-initOperations cannot initialize session volume '${operation.id}'`);
      }
      initializedVolumeIds.add(operation.id);
      return `state-volume:${operation.id}`;
    }
    if (operation.kind === 'prepared-file') {
      const file = contract.files.find((candidate) => candidate.id === operation.id);
      if (!file) throw new Error(`${provider}.${phase}Operations.prepared-file references unknown '${operation.id}'`);
      if (file.prepare.when !== phase) {
        throw new Error(
          `${provider}.${phase}Operations.prepared-file '${operation.id}' has lifecycle '${file.prepare.when}'`,
        );
      }
      const volume = contract.stateVolumes.find((candidate) => candidate.id === file.volumeId)!;
      requireEarlierVolume(provider, phase, initializedVolumeIds, file.volumeId, 'prepared-file', operation.id);
      if (phase === 'group-init' && volume.scope !== 'group') {
        throw new Error(`${provider}.group-initOperations cannot prepare a file in session volume '${file.volumeId}'`);
      }
      return `prepared-file:${operation.id}`;
    }
    if (operation.kind === 'skill-backing') {
      assertReference(backingIds, operation.id, `${provider}.${phase}Operations.skill-backing`);
      assertAllowed(operation.action, ['initialize', 'sync'], `${provider}.${phase}Operations.skill-backing.action`);
      const expected = phase === 'group-init' ? 'initialize' : 'sync';
      if (operation.action !== expected) {
        throw new Error(`${provider}.${phase}Operations.skill-backing '${operation.id}' must use '${expected}'`);
      }
      const backing = contract.skillBackings.find((candidate) => candidate.id === operation.id)!;
      const location = backing.location;
      if (location.kind === 'state-volume') {
        requireEarlierVolume(provider, phase, initializedVolumeIds, location.volumeId, 'skill-backing', operation.id);
      }
      if (phase === 'group-init' && location.kind === 'state-volume') {
        const volume = contract.stateVolumes.find((candidate) => candidate.id === location.volumeId)!;
        if (volume.scope !== 'group') {
          throw new Error(
            `${provider}.group-initOperations cannot initialize a backing in session volume '${volume.id}'`,
          );
        }
      }
      return `skill-backing:${operation.id}`;
    }
    if (operation.kind === 'project-document') {
      if (phase !== 'every-spawn') throw new Error(`${provider}.project-document is an every-spawn operation`);
      if (contract.projectDocument === undefined) {
        throw new Error(`${provider}.${phase}Operations.project-document requires a project document`);
      }
      return 'project-document';
    }
    if (phase !== 'every-spawn') throw new Error(`${provider}.legacy-overlay is an every-spawn operation`);
    return 'legacy-overlay';
  });
  unique(keys, `${provider}.${phase}Operations`);
  return keys;
}

function requireEarlierVolume(
  provider: string,
  phase: 'group-init' | 'every-spawn',
  initializedVolumeIds: ReadonlySet<string>,
  volumeId: string,
  kind: 'prepared-file' | 'skill-backing',
  id: string,
): void {
  if (!initializedVolumeIds.has(volumeId)) {
    throw new Error(`${provider}.${phase}Operations.${kind} '${id}' must follow state-volume '${volumeId}'`);
  }
}

function requireOperation(operations: readonly string[], key: string, provider: string): void {
  if (!operations.includes(key)) throw new Error(`${provider} is missing ordered operation '${key}'`);
}

function requireSpawnOperation(operations: readonly string[], key: string, provider: string): void {
  if (!operations.includes(key)) {
    throw new Error(`${provider} allowlisted-extra mount '${key}' must appear in spawnOperations`);
  }
}

function assertAllowed(value: unknown, allowed: readonly unknown[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.map((entry) => `'${String(entry)}'`).join(', ')}`);
  }
}

function assertArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
}

function unique(values: readonly string[], field: string): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${field} must be unique; duplicate '${value}'`);
    seen.add(value);
  }
  return seen;
}

function assertReference(values: ReadonlySet<string>, value: string, field: string): void {
  if (!values.has(value)) throw new Error(`${field} references unknown '${value}'`);
}

function assertName(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${field} must be lowercase kebab-case`);
  }
}

function assertFileName(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`${field} must be one file or directory name`);
  }
}

function assertRelativePath(value: unknown, field: string, allowEmpty = false): asserts value is string {
  if (allowEmpty && value === '') return;
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.endsWith('/') ||
    path.posix.isAbsolute(value) ||
    value.split('/').includes('..') ||
    path.posix.normalize(value) !== value ||
    value === '.'
  ) {
    throw new Error(`${field} must be a canonical relative path`);
  }
}

function assertContainerPath(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !path.posix.isAbsolute(value) ||
    value.includes('\\') ||
    (value.length > 1 && value.endsWith('/')) ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`${field} must be a canonical absolute container path`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
}

function assertCommandArray(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const command of value) {
    if (typeof command !== 'string' || !/^\/[a-z0-9-]+$/.test(command)) {
      throw new Error(`${field} contains invalid command '${String(command)}'`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
