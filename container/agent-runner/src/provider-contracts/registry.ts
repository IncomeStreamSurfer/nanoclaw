/**
 * Container-runtime provider contracts.
 *
 * A contract is an implementation object, not a description: every declared
 * capability carries the function that implements it, core calls those
 * functions at the declared moments, and registration executes behavioral
 * probes against them. A capability that is declared but not implemented —
 * or implemented but ignored by the file it claims to configure — fails at
 * registration, not silently at query time.
 */

import path from 'path';

import type { AgentProvider, McpServerConfig } from '../providers/types.js';

export type RuntimeConfigurationCapabilityName = 'executionPolicy' | 'inference' | 'memory' | 'mcpServers';

/** Shared shape of the memory session-hook registration (structural mirror of memory/session-hook.ts). */
export interface RuntimeMemoryHookInput {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/** Core-owned inputs for each configuration capability. */
export interface RuntimeConfigurationInputs {
  /** No core-varied input: the container is the security boundary, always. */
  executionPolicy: undefined;
  inference: { model?: string; effort?: string; tone?: string; speed?: string };
  memory: RuntimeMemoryHookInput;
  mcpServers: Record<string, McpServerConfig>;
}

export interface RuntimeFileTransformInput {
  exists: boolean;
  content: string;
  filePath: string;
  /** Rendered output of every configuration capability bound to this file. */
  sections: Partial<Record<RuntimeConfigurationCapabilityName, unknown>>;
}

export type RuntimeFileTransformResult = { kind: 'unchanged' } | { kind: 'replace'; content: string };

export interface RuntimeManagedFile {
  id: string;
  /** Directory the file lives under; the provider names it, core writes into it. */
  root(): string;
  relativePath: string;
  when: 'memory-session-hook-registration' | 'before-query';
  read: 'none' | 'text-if-present';
  write: 'direct-replace';
  /** Assembles the full file from prior content plus the rendered capability sections. */
  transform(input: RuntimeFileTransformInput): RuntimeFileTransformResult;
}

/** One file-carried piece of a configuration capability. */
export interface RuntimeCapabilitySection<I> {
  managedFile: string;
  render(input: I): unknown;
}

/**
 * How a provider implements one configuration capability. At least one
 * surface is required:
 *
 * - `sections` — file-carried: core renders each section from the core-owned
 *   input and hands it to the managed file's transform at write time.
 * - `resolve` — provider-runtime: a pure derivation of the provider's own
 *   configuration from the core-owned input; the provider's real code path
 *   must consume the same function.
 *
 * `probes` overrides the registry's default probe inputs when the default
 * fixtures cannot exercise the implementation (e.g. env-gated config).
 */
export interface RuntimeConfigurationCapability<I> {
  sections?: readonly RuntimeCapabilitySection<I>[];
  resolve?(input: I, environment: NodeJS.ProcessEnv): unknown;
  probes?: { a: I; b: I; environment?: NodeJS.ProcessEnv };
}

export interface ProviderRuntimeConfiguration {
  executionPolicy: RuntimeConfigurationCapability<RuntimeConfigurationInputs['executionPolicy']>;
  inference: RuntimeConfigurationCapability<RuntimeConfigurationInputs['inference']>;
  memory: RuntimeConfigurationCapability<RuntimeConfigurationInputs['memory']>;
  mcpServers: RuntimeConfigurationCapability<RuntimeConfigurationInputs['mcpServers']>;
}

export interface RuntimeArchivePlan {
  relativePath: string;
  content: string;
  write: 'replace' | 'append';
  clockSamples?: {
    beforeDirectory: number;
    afterDirectory: number;
  };
}
export type RuntimeArchivePlanner = (input: unknown) => RuntimeArchivePlan | null;

export interface RuntimeContinuationRotationPlan {
  reason?: string;
  clockSamples?: 1;
}
export type RuntimeContinuationRotationPlanner = (input: unknown) => RuntimeContinuationRotationPlan | null;

export interface ProviderRuntimeContract {
  /** Files core writes for the provider. Empty when the provider manages no files. */
  managedFiles: readonly RuntimeManagedFile[];
  /** The four configuration responsibilities every provider must implement. */
  configuration: ProviderRuntimeConfiguration;
  /** Core-executed conversation archive; absent when the provider persists its own history. */
  archives?: { trigger: 'pre-compact' | 'exchange-complete'; plan: RuntimeArchivePlanner };
  /** Core-executed continuation rotation; absent when the provider has no on-disk transcript. */
  continuationRotation?: {
    plan: RuntimeContinuationRotationPlanner;
    root(): string;
    searchSubdirectory: string;
    extension: string;
  };
  /** Provider trace locations core may read for diagnostics. Empty when none exist. */
  traceReaders: readonly { id: string; read(): string | null }[];
  textDelivery: 'mid-turn-complete' | 'result';
  /** How context compaction is observed; absent when the provider owns its context lifecycle opaquely. */
  compaction?: 'provider-hook' | 'provider-native';
  commands: {
    formatting: 'native' | 'xml';
    nativeAdmin: readonly string[];
    nativeFiltered: readonly string[];
  };
}

const contracts = new Map<string, ProviderRuntimeContract>();

const CAPABILITY_NAMES: readonly RuntimeConfigurationCapabilityName[] = [
  'executionPolicy',
  'inference',
  'memory',
  'mcpServers',
];

/** Default probe fixtures for the input-sensitivity checks. */
const DEFAULT_PROBES: {
  [K in Exclude<RuntimeConfigurationCapabilityName, 'executionPolicy'>]: {
    a: RuntimeConfigurationInputs[K];
    b: RuntimeConfigurationInputs[K];
  };
} = {
  inference: { a: { model: 'nanoclaw-probe-model-a' }, b: { model: 'nanoclaw-probe-model-b' } },
  memory: {
    a: { command: 'nanoclaw-probe-hook-a', legacyCommands: [], sources: ['startup'] },
    b: { command: 'nanoclaw-probe-hook-b', legacyCommands: [], sources: ['startup'] },
  },
  mcpServers: {
    a: {},
    b: { 'nanoclaw-probe-server': { command: 'nanoclaw-probe-command' } },
  },
};

export function registerProviderRuntimeContract(name: string, contract: ProviderRuntimeContract): void {
  const key = providerKey(name);
  if (contracts.has(key)) throw new Error(`Provider runtime contract already registered: ${key}`);
  validateContract(key, contract);
  probeConfiguration(key, contract);
  contracts.set(key, deepFreeze(contract));
}

export function getProviderRuntimeContract(name: string | null | undefined): ProviderRuntimeContract | undefined {
  return name ? contracts.get(name.toLowerCase()) : undefined;
}

export function hasDeclaredProviderRuntimeContract(name: string | null | undefined): boolean {
  return getProviderRuntimeContract(name) !== undefined;
}

export function listProviderRuntimeContractNames(): string[] {
  return [...contracts.keys()];
}

export function listProviderRuntimeContracts(): readonly ProviderRuntimeContract[] {
  return [...contracts.values()];
}

export function listRegisteredTraceReaders(): readonly (() => string | null)[] {
  const readers: (() => string | null)[] = [];
  for (const contract of contracts.values()) {
    for (const trace of contract.traceReaders) readers.push(trace.read);
  }
  return readers;
}

/**
 * Build the rendered capability sections for one managed file from the
 * core-owned inputs. Only capabilities with an input present render; the
 * executionPolicy input is always present (it is `undefined` by type).
 */
export function renderManagedFileSections(
  contract: ProviderRuntimeContract,
  file: RuntimeManagedFile,
  inputs: Partial<RuntimeConfigurationInputs>,
): Partial<Record<RuntimeConfigurationCapabilityName, unknown>> {
  const sections: Partial<Record<RuntimeConfigurationCapabilityName, unknown>> = {};
  for (const capability of CAPABILITY_NAMES) {
    const section = (contract.configuration[capability].sections ?? []).find(
      (candidate) => candidate.managedFile === file.id,
    );
    if (!section) continue;
    if (capability !== 'executionPolicy' && !(capability in inputs)) {
      throw new Error(`Managed file '${file.id}' needs the ${capability} input, which was not provided`);
    }
    sections[capability] = (section.render as (input: unknown) => unknown)(
      capability === 'executionPolicy' ? undefined : inputs[capability],
    );
  }
  return sections;
}

export function validateProviderRuntimeInstance(
  provider: string,
  contract: ProviderRuntimeContract,
  instance: AgentProvider,
): void {
  const native = contract.commands.formatting === 'native';
  if (instance.supportsNativeSlashCommands !== native) {
    throw new Error(
      `Provider '${provider}' runtime contract commands.formatting does not match supportsNativeSlashCommands`,
    );
  }
  const emitsMidTurnText = contract.textDelivery === 'mid-turn-complete';
  if (Boolean(instance.emitsMidTurnText) !== emitsMidTurnText) {
    throw new Error(`Provider '${provider}' runtime contract textDelivery does not match emitsMidTurnText`);
  }
  const declaresExchangeArchive = contract.archives?.trigger === 'exchange-complete';
  if (declaresExchangeArchive !== (typeof instance.onExchangeComplete === 'function')) {
    throw new Error(
      `Provider '${provider}' runtime contract exchange-complete archives do not match onExchangeComplete`,
    );
  }
  const declaresRotation = contract.continuationRotation !== undefined;
  if (declaresRotation !== (typeof instance.maybeRotateContinuation === 'function')) {
    throw new Error(
      `Provider '${provider}' runtime contract continuationRotation does not match maybeRotateContinuation`,
    );
  }
}

function validateContract(provider: string, contract: ProviderRuntimeContract): void {
  if (!Array.isArray(contract.managedFiles)) throw new Error(`${provider}.managedFiles must be an array`);
  unique(
    contract.managedFiles.map((file) => file.id),
    `${provider}.managedFiles[].id`,
  );
  unique(
    contract.managedFiles.map((file) => file.relativePath),
    `${provider}.managedFiles[] paths`,
  );
  for (const file of contract.managedFiles) {
    contractName(file.id, `${provider}.managedFiles[].id`);
    requireFunction(file.root, `${provider}.managedFiles.${file.id}.root`);
    requireFunction(file.transform, `${provider}.managedFiles.${file.id}.transform`);
    assertRelativePath(file.relativePath, `${provider}.managedFiles.${file.id}.relativePath`);
    assertAllowed(
      file.when,
      ['memory-session-hook-registration', 'before-query'],
      `${provider}.managedFiles.${file.id}.when`,
    );
    assertAllowed(file.read, ['none', 'text-if-present'], `${provider}.managedFiles.${file.id}.read`);
    assertAllowed(file.write, ['direct-replace'], `${provider}.managedFiles.${file.id}.write`);
  }

  if (contract.configuration === null || typeof contract.configuration !== 'object') {
    throw new Error(`${provider}.configuration is required`);
  }
  for (const capability of CAPABILITY_NAMES) {
    const field = `${provider}.configuration.${capability}`;
    const implementation = contract.configuration[capability];
    if (implementation === null || typeof implementation !== 'object') {
      throw new Error(`${field} is required`);
    }
    const sections = implementation.sections ?? [];
    if (!Array.isArray(sections)) throw new Error(`${field}.sections must be an array`);
    if (sections.length === 0 && implementation.resolve === undefined) {
      throw new Error(`${field} must implement at least one surface (sections or resolve)`);
    }
    if (implementation.resolve !== undefined) requireFunction(implementation.resolve, `${field}.resolve`);
    unique(
      sections.map((section) => section.managedFile),
      `${field}.sections[].managedFile`,
    );
    for (const section of sections) {
      requireFunction(section.render, `${field}.sections.${section.managedFile}.render`);
      if (!contract.managedFiles.some((file) => file.id === section.managedFile)) {
        throw new Error(`${field} references missing managed file '${section.managedFile}'`);
      }
    }
  }

  if (contract.archives !== undefined) {
    assertAllowed(contract.archives.trigger, ['pre-compact', 'exchange-complete'], `${provider}.archives.trigger`);
    requireFunction(contract.archives.plan, `${provider}.archives.plan`);
    if (contract.archives.trigger === 'pre-compact' && contract.compaction !== 'provider-hook') {
      throw new Error(`${provider}.archives pre-compact trigger requires compaction 'provider-hook'`);
    }
  }

  if (contract.continuationRotation !== undefined) {
    const rotation = contract.continuationRotation;
    requireFunction(rotation.plan, `${provider}.continuationRotation.plan`);
    requireFunction(rotation.root, `${provider}.continuationRotation.root`);
    assertRelativePath(rotation.searchSubdirectory, `${provider}.continuationRotation.searchSubdirectory`);
    if (!rotation.extension?.startsWith('.') || rotation.extension.includes('/') || rotation.extension.includes('\\')) {
      throw new Error(`${provider}.continuationRotation.extension must be a file extension`);
    }
  }

  if (!Array.isArray(contract.traceReaders)) throw new Error(`${provider}.traceReaders must be an array`);
  unique(
    contract.traceReaders.map((trace) => trace.id),
    `${provider}.traceReaders[].id`,
  );
  for (const trace of contract.traceReaders) {
    contractName(trace.id, `${provider}.traceReaders[].id`);
    requireFunction(trace.read, `${provider}.traceReaders.${trace.id}.read`);
  }

  assertAllowed(contract.textDelivery, ['mid-turn-complete', 'result'], `${provider}.textDelivery`);
  if (contract.compaction !== undefined) {
    assertAllowed(contract.compaction, ['provider-hook', 'provider-native'], `${provider}.compaction`);
  }
  assertAllowed(contract.commands?.formatting, ['native', 'xml'], `${provider}.commands.formatting`);
  assertCommandArray(contract.commands?.nativeAdmin, `${provider}.commands.nativeAdmin`);
  assertCommandArray(contract.commands?.nativeFiltered, `${provider}.commands.nativeFiltered`);
  unique(contract.commands.nativeAdmin, `${provider}.commands.nativeAdmin`);
  unique(contract.commands.nativeFiltered, `${provider}.commands.nativeFiltered`);
}

/**
 * Execute the registered implementations against probe inputs, so a
 * capability whose function is dead — never rendered into its file, or
 * insensitive to the input it claims to carry — is rejected at registration.
 */
function probeConfiguration(provider: string, contract: ProviderRuntimeContract): void {
  const probeInputs = (
    capability: RuntimeConfigurationCapabilityName,
    variant: 'a' | 'b',
  ): RuntimeConfigurationInputs[RuntimeConfigurationCapabilityName] => {
    if (capability === 'executionPolicy') return undefined;
    const declared = contract.configuration[capability].probes as
      | { a: RuntimeConfigurationInputs[typeof capability]; b: RuntimeConfigurationInputs[typeof capability] }
      | undefined;
    return (declared ?? DEFAULT_PROBES[capability])[variant];
  };

  const renderFileContent = (
    file: RuntimeManagedFile,
    overrides: Partial<Record<RuntimeConfigurationCapabilityName, { render: boolean; variant: 'a' | 'b' }>>,
  ): { threw: boolean; content: string | null } => {
    const sections: Partial<Record<RuntimeConfigurationCapabilityName, unknown>> = {};
    for (const capability of CAPABILITY_NAMES) {
      const section = (contract.configuration[capability].sections ?? []).find(
        (candidate) => candidate.managedFile === file.id,
      );
      if (!section) continue;
      const override = overrides[capability] ?? { render: true, variant: 'a' as const };
      if (!override.render) continue;
      sections[capability] = (section.render as (input: unknown) => unknown)(
        probeInputs(capability, override.variant),
      );
    }
    try {
      const result = file.transform({
        exists: false,
        content: '',
        filePath: `nanoclaw-probe:${file.relativePath}`,
        sections,
      });
      return { threw: false, content: result.kind === 'replace' ? result.content : null };
    } catch {
      return { threw: true, content: null };
    }
  };

  const boundFiles = new Map<string, RuntimeManagedFile>();
  for (const capability of CAPABILITY_NAMES) {
    for (const section of contract.configuration[capability].sections ?? []) {
      const file = contract.managedFiles.find((candidate) => candidate.id === section.managedFile)!;
      boundFiles.set(file.id, file);
    }
  }

  const baselines = new Map<string, string>();
  for (const [id, file] of boundFiles) {
    const baseline = renderFileContent(file, {});
    if (baseline.threw || baseline.content === null) {
      throw new Error(
        `${provider}.managedFiles.${id} transform must produce content from an empty state during probes`,
      );
    }
    baselines.set(id, baseline.content);
  }

  const probeEnvironment = (capability: RuntimeConfigurationCapabilityName): NodeJS.ProcessEnv =>
    contract.configuration[capability].probes?.environment ?? {};

  for (const capability of CAPABILITY_NAMES) {
    const field = `${provider}.configuration.${capability}`;
    const implementation = contract.configuration[capability];
    const sections = implementation.sections ?? [];

    for (const section of sections) {
      const file = boundFiles.get(section.managedFile)!;
      const removed = renderFileContent(file, { [capability]: { render: false, variant: 'a' } });
      if (!removed.threw && removed.content === baselines.get(file.id)) {
        throw new Error(`${field} section does not affect managed file '${file.id}'`);
      }
    }

    let resolvedA: unknown;
    if (implementation.resolve) {
      resolvedA = implementation.resolve(probeInputs(capability, 'a') as never, probeEnvironment(capability));
      if (resolvedA === undefined) {
        throw new Error(`${field}.resolve must produce a value for the probe input`);
      }
    }

    if (capability === 'executionPolicy') continue;

    let inputSensitive = false;
    for (const section of sections) {
      const file = boundFiles.get(section.managedFile)!;
      const variant = renderFileContent(file, { [capability]: { render: true, variant: 'b' } });
      if (variant.threw || variant.content !== baselines.get(file.id)) {
        inputSensitive = true;
        break;
      }
    }
    if (!inputSensitive && implementation.resolve) {
      const resolvedB = implementation.resolve(probeInputs(capability, 'b') as never, probeEnvironment(capability));
      inputSensitive = stableStringify(resolvedA) !== stableStringify(resolvedB);
    }
    if (!inputSensitive) {
      throw new Error(`${field} does not respond to its configuration input`);
    }
  }
}

function providerKey(name: string): string {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider runtime contract name must be lowercase kebab-case: '${name}'`);
  }
  return key;
}

function contractName(name: string, field: string): string {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${field} must be lowercase kebab-case`);
  }
  return name;
}

function requireFunction(value: unknown, field: string): void {
  if (typeof value !== 'function') throw new Error(`${field} must be a function`);
}

function assertAllowed(value: unknown, allowed: readonly unknown[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.map((entry) => `'${String(entry)}'`).join(', ')}`);
  }
}

function unique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${field} must be unique; duplicate '${value}'`);
    seen.add(value);
  }
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.endsWith('/') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').includes('..') ||
    value === '.'
  ) {
    throw new Error(`${field} must be a canonical relative path`);
  }
}

function assertCommandArray(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const command of value) {
    if (typeof command !== 'string' || !/^\/[a-z0-9-]+$/.test(command)) {
      throw new Error(`${field} contains invalid command '${String(command)}'`);
    }
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'function') return '[function]';
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
    return entry;
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
