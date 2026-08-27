import { getSetupProvider } from '../providers/registry.js';
import { getProviderDescriptor } from '../providers/skill-descriptor.js';

/**
 * How interactive setup handles one provider. Every answer names concrete
 * behavior and conformance cross-checks each against the provider's actual
 * setup registration and skill descriptor — a declared capability whose
 * implementation is missing fails, and 'none' is the explicit no-op answer.
 */
export interface ProviderSetupContract {
  installOffer: 'built-in' | 'skill-descriptor' | 'none';
  /** The /add-<name> skill that installs the payload; absent for built-in providers. */
  installSkill?: string;
  image: 'hardened-compatible' | 'local-required';
  auth: 'standard' | 'provider' | 'none';
  installVerification: 'provider' | 'none';
  failureAssist: 'provider' | 'claude-fallback' | 'none';
}

const contracts = new Map<string, ProviderSetupContract>();

export function registerProviderSetupContract(name: string, contract: ProviderSetupContract): void {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider setup contract name must be lowercase kebab-case: '${name}'`);
  }
  if (contracts.has(key)) throw new Error(`Provider setup contract already registered: ${key}`);
  assertAllowed(contract.installOffer, ['built-in', 'skill-descriptor', 'none'], `${key}.installOffer`);
  if (contract.installSkill !== undefined && (typeof contract.installSkill !== 'string' || !contract.installSkill.trim())) {
    throw new Error(`${key}.installSkill must be a non-empty string`);
  }
  assertAllowed(contract.image, ['hardened-compatible', 'local-required'], `${key}.image`);
  assertAllowed(contract.auth, ['standard', 'provider', 'none'], `${key}.auth`);
  assertAllowed(contract.installVerification, ['provider', 'none'], `${key}.installVerification`);
  assertAllowed(contract.failureAssist, ['provider', 'claude-fallback', 'none'], `${key}.failureAssist`);
  contracts.set(key, deepFreeze({ ...contract }));
}

export function getProviderSetupContract(name: string | null | undefined): ProviderSetupContract | undefined {
  return name ? contracts.get(name.toLowerCase()) : undefined;
}

export function listProviderSetupContractNames(): string[] {
  return [...contracts.keys()];
}

export function providerImagePolicy(provider: string): 'local-required' | 'hardened-compatible' {
  const normalized = provider.toLowerCase();
  const declared = getProviderSetupContract(normalized)?.image;
  if (declared !== undefined) return declared;
  return (
    getProviderDescriptor(normalized)?.image ?? (normalized === 'claude' ? 'hardened-compatible' : 'local-required')
  );
}

export function assertSetupProviderConformance(): void {
  for (const [provider, contract] of contracts) {
    const entry = getSetupProvider(provider);
    const descriptor = getProviderDescriptor(provider);
    if (contract.installOffer === 'skill-descriptor' && !descriptor?.offered) {
      throw new Error(`${provider}.installOffer requires an offered skill descriptor`);
    }
    if (contract.installSkill !== undefined && descriptor?.installSkill !== contract.installSkill) {
      throw new Error(`${provider}.installSkill does not match its skill descriptor`);
    }
    if (descriptor && descriptor.image !== contract.image) {
      throw new Error(`${provider}.image does not match its skill descriptor`);
    }
    if (contract.auth !== 'none') {
      if (!entry) throw new Error(`Provider '${provider}' setup contract has no setup registration`);
      if (contract.auth === 'provider' && !entry.runAuth) throw new Error(`${provider}.auth requires runAuth`);
      if (contract.auth === 'standard' && entry.runAuth) {
        throw new Error(`${provider}.auth standard must not provide runAuth`);
      }
    }
    if (contract.installVerification === 'provider' && !entry?.runInstallCheck) {
      throw new Error(`${provider}.installVerification requires runInstallCheck`);
    }
    if (contract.failureAssist === 'provider' && !entry?.offerFailureAssist) {
      throw new Error(`${provider}.failureAssist requires offerFailureAssist`);
    }
  }
}

function assertAllowed(value: unknown, allowed: readonly unknown[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.map((entry) => `'${String(entry)}'`).join(', ')}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
