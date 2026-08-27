import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { log } from '../log.js';
import { BASE_INSTRUCTIONS_PATH, type ProjectDocSpec } from '../project-doc-compose.js';

import {
  listProviderHostContracts,
  type ProviderFileDiagnostic,
  type ProviderHostContract,
  type ProviderHostOperation,
  type ProviderSkillBackingLocation,
  type ProviderStateVolume,
} from './registry.js';

export function protectedProviderDocumentSourcePaths(projectRoot: string): string[] {
  const anyProtection = listProviderHostContracts().some(
    (contract) => contract.projectDocument?.sourceProtection === 'install-surface',
  );
  return anyProtection ? [path.resolve(projectRoot, BASE_INSTRUCTIONS_PATH)] : [];
}

export function providerProjectDocSpec(contract: ProviderHostContract): ProjectDocSpec | undefined {
  if (contract.projectDocument === undefined) return undefined;
  const { fileName, instructions, maxBytes } = contract.projectDocument;
  return {
    fileName,
    ...(instructions ? { instructions } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

export function providerStateVolumePath(
  volume: ProviderStateVolume,
  agentGroupId: string,
  sessionDirectory?: string,
): string {
  if (volume.scope === 'session') {
    if (!sessionDirectory) throw new Error(`Session directory required for provider state volume '${volume.id}'`);
    return resolveWithinRoot(sessionDirectory, volume.directory);
  }
  const groupStateRoot = path.resolve(DATA_DIR, 'v2-sessions', agentGroupId);
  return resolveWithinRoot(groupStateRoot, volume.directory);
}

/** Realize the group-lifetime portion of a declared provider contract. */
export function initializeProviderGroupSurfaces(
  provider: string,
  contract: ProviderHostContract,
  agentGroupId: string,
  groupDir: string,
): string[] {
  const initialized: string[] = [];
  const volumes = new Map(contract.stateVolumes.map((volume) => [volume.id, volume]));
  for (const operation of contract.groupInitOperations) {
    if (operation.kind === 'state-volume') {
      const volume = requireById(contract.stateVolumes, operation.id, provider, operation);
      const hostPath = providerStateVolumePath(volume, agentGroupId);
      if (!fs.existsSync(hostPath)) {
        fs.mkdirSync(hostPath, { recursive: true });
        initialized.push(volume.directory);
      }
    } else if (operation.kind === 'prepared-file') {
      initializeFile(provider, contract, operation.id, volumes, agentGroupId, initialized);
    } else if (operation.kind === 'skill-backing') {
      const backing = requireById(contract.skillBackings, operation.id, provider, operation);
      const skillsPath = providerSkillDirectory(backing, volumes, agentGroupId, groupDir);
      if (!fs.existsSync(skillsPath)) {
        fs.mkdirSync(skillsPath, { recursive: true });
        initialized.push(`${path.basename(skillsPath)}/`);
      }
    }
  }

  return initialized;
}

export interface ProviderSpawnRealization {
  skillBackingPaths: Map<string, string>;
  contribution: import('../providers/provider-container-registry.js').ProviderContainerContribution;
}

/** Realize every-spawn operations in provider-declared order. */
export async function realizeProviderSpawnSurfaces(
  provider: string,
  contract: ProviderHostContract,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory: string,
  selectedSkills: readonly string[],
  actions: {
    legacyOverlay: () => Promise<import('../providers/provider-container-registry.js').ProviderContainerContribution>;
    composeProjectDocument: (spec: ProjectDocSpec) => Promise<void>;
  },
): Promise<ProviderSpawnRealization> {
  const volumes = new Map(contract.stateVolumes.map((volume) => [volume.id, volume]));
  const paths = new Map<string, string>();
  let contribution: import('../providers/provider-container-registry.js').ProviderContainerContribution = {};
  for (const operation of contract.spawnOperations) {
    if (operation.kind === 'state-volume') {
      const volume = requireById(contract.stateVolumes, operation.id, provider, operation);
      fs.mkdirSync(providerStateVolumePath(volume, agentGroupId, sessionDirectory), { recursive: true });
    } else if (operation.kind === 'prepared-file') {
      prepareSpawnFile(provider, contract, operation.id, volumes, agentGroupId, sessionDirectory);
    } else if (operation.kind === 'skill-backing') {
      const backing = requireById(contract.skillBackings, operation.id, provider, operation);
      const backingRoot = skillBackingPath(backing.location, volumes, agentGroupId, groupDir, sessionDirectory);
      const skillsPath = resolveWithinRoot(backingRoot, backing.skillsSubdirectory);
      paths.set(backing.id, backingRoot);
      fs.mkdirSync(skillsPath, { recursive: true });
      if (backing.sharedLinks !== undefined) {
        syncSharedSkillLinks(skillsPath, selectedSkills, backing.conflictDiagnostics === 'warn');
      }
      if (backing.templateCopies === 'copy') {
        materializeTemplateSkills(agentGroupId, skillsPath);
      }
    } else if (operation.kind === 'project-document') {
      const spec = providerProjectDocSpec(contract);
      if (spec) await actions.composeProjectDocument(spec);
    } else {
      contribution = await actions.legacyOverlay();
      contribution = contribution.env ? { env: contribution.env } : {};
    }
  }
  for (const backing of contract.skillBackings) {
    paths.set(backing.id, skillBackingPath(backing.location, volumes, agentGroupId, groupDir, sessionDirectory));
  }
  return { skillBackingPaths: paths, contribution };
}

function initializeFile(
  provider: string,
  contract: ProviderHostContract,
  fileId: string,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  initialized: string[],
): void {
  const file = requireById(contract.files, fileId, provider, { kind: 'prepared-file', id: fileId });
  const volume = volumes.get(file.volumeId)!;
  const filePath = resolveWithinRoot(providerStateVolumePath(volume, agentGroupId), file.relativePath);
  if (!fs.existsSync(filePath)) {
    if (file.prepare.operation !== 'create-if-missing') return;
    const options = file.prepare.mode === 'process-default' ? undefined : { mode: file.prepare.mode };
    fs.writeFileSync(filePath, file.prepare.content, options);
    initialized.push(file.relativePath);
    return;
  }
  if (file.reconcile === undefined || file.reconcile.when !== 'group-init') return;
  const transformerProvider = file.reconcile.transformerProvider ?? provider;
  const transformer = file.reconcile.transform;
  try {
    const result = transformer.transform(fs.readFileSync(filePath, 'utf-8'), filePath);
    emitDiagnostics(result.diagnostics);
    if (result.kind === 'replace') {
      writeAtomicReplace(filePath, result.content);
      initialized.push(`${file.relativePath} (reconciled ${providerName(transformerProvider)} settings)`);
    }
  } catch (err) {
    emitDiagnostic(transformer.mapIoFailure(err, filePath));
  }
}

function prepareSpawnFile(
  provider: string,
  contract: ProviderHostContract,
  fileId: string,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  sessionDirectory: string,
): void {
  const file = requireById(contract.files, fileId, provider, { kind: 'prepared-file', id: fileId });
  const volume = volumes.get(file.volumeId)!;
  const filePath = resolveWithinRoot(
    providerStateVolumePath(volume, agentGroupId, sessionDirectory),
    file.relativePath,
  );
  if (file.prepare.operation === 'append-open-close') {
    const mode = file.prepare.mode === 'process-default' ? undefined : file.prepare.mode;
    fs.closeSync(fs.openSync(filePath, 'a', mode));
  }
}

function providerSkillDirectory(
  backing: ProviderHostContract['skillBackings'][number],
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
): string {
  return resolveWithinRoot(
    skillBackingPath(backing.location, volumes, agentGroupId, groupDir),
    backing.skillsSubdirectory,
  );
}

function requireById<T extends { id: string }>(
  values: readonly T[],
  id: string,
  provider: string,
  operation: ProviderHostOperation,
): T {
  const value = values.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Provider '${provider}' ${operation.kind} references unknown '${id}'`);
  return value;
}

function skillBackingPath(
  location: ProviderSkillBackingLocation,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory?: string,
): string {
  if (location.kind === 'group-directory') {
    return resolveWithinRoot(groupDir, location.directory, location.subdirectory);
  }
  const volume = volumes.get(location.volumeId);
  if (!volume) throw new Error(`Provider skill backing references unknown volume '${location.volumeId}'`);
  return resolveWithinRoot(providerStateVolumePath(volume, agentGroupId, sessionDirectory), location.subdirectory);
}

function syncSharedSkillLinks(skillsDir: string, desiredSkills: readonly string[], warnOnConflict: boolean): void {
  const desired = new Set(desiredSkills);
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desired.has(entry)) fs.unlinkSync(entryPath);
  }

  for (const skill of desiredSkills) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink() && warnOnConflict) {
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        { skill, path: linkPath },
      );
    }
  }
}

function resolveWithinRoot(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Provider contract path escapes its resolved root: '${segments.join('/')}'`);
  }
  return resolved;
}

function writeAtomicReplace(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Rename consumed the temp file, or creation failed before it existed.
    }
  }
}

function emitDiagnostics(diagnostics: readonly ProviderFileDiagnostic[] | undefined): void {
  for (const diagnostic of diagnostics ?? []) emitDiagnostic(diagnostic);
}

function emitDiagnostic(diagnostic: ProviderFileDiagnostic): void {
  log[diagnostic.level](diagnostic.message, diagnostic.fields);
}

function providerName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
