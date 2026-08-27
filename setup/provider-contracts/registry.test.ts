import { describe, expect, it } from 'vitest';

import './index.js';
import '../providers/index.js';
import {
  assertSetupProviderConformance,
  getProviderSetupContract,
  providerImagePolicy,
  registerProviderSetupContract,
  type ProviderSetupContract,
} from './registry.js';

function setupContractWith(overrides: Partial<ProviderSetupContract>): ProviderSetupContract {
  return { ...getProviderSetupContract('claude')!, ...overrides };
}

function contractName(field: string, suffix: string): string {
  return `setup-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

describe('provider setup contracts', () => {
  it('loads and validates the complete Claude setup declaration', () => {
    expect(getProviderSetupContract('CLAUDE')).toEqual({
      installOffer: 'built-in',
      image: 'hardened-compatible',
      auth: 'standard',
      installVerification: 'none',
      failureAssist: 'claude-fallback',
    });
    expect(assertSetupProviderConformance).not.toThrow();
  });

  it('defaults only Claude to hardened-compatible images', () => {
    expect(providerImagePolicy('CLAUDE')).toBe('hardened-compatible');
    expect(providerImagePolicy('unknown-provider')).toBe('local-required');
  });

  it('rejects an empty installSkill and stores an immutable contract', () => {
    expect(() =>
      registerProviderSetupContract(
        `setup-empty-install-skill-${process.pid}`,
        setupContractWith({ installSkill: ' ' }),
      ),
    ).toThrow(/installSkill must be a non-empty string/);

    const name = `setup-immutable-${process.pid}`;
    registerProviderSetupContract(name, setupContractWith({}));
    const stored = getProviderSetupContract(name)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => ((stored as { auth: string }).auth = 'provider')).toThrow();
  });

  it.each([
    ['installOffer', 'invalid'],
    ['installSkill', 1],
    ['image', 'invalid'],
    ['auth', 'invalid'],
    ['installVerification', 'invalid'],
    ['failureAssist', 'invalid'],
  ] as const)('rejects an invalid value for %s', (field, value) => {
    expect(() =>
      registerProviderSetupContract(
        contractName(field, 'invalid-value'),
        setupContractWith({ [field]: value } as Partial<ProviderSetupContract>),
      ),
    ).toThrow(`.${field}`);
  });

  it.each(['installOffer', 'image', 'auth', 'installVerification', 'failureAssist'] as const)(
    'requires %s to be answered explicitly',
    (field) => {
      const contract = setupContractWith({});
      delete (contract as Record<string, unknown>)[field];
      expect(() => registerProviderSetupContract(contractName(field, 'missing'), contract)).toThrow(`.${field}`);
    },
  );
});
