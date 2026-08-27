import { describe, expect, it } from 'bun:test';

import '../providers/index.js';
import { createProvider } from '../providers/factory.js';
import { listProviderNames } from '../providers/provider-registry.js';
import './index.js';
import { hasDeclaredProviderRuntimeContract } from './registry.js';

describe('installed runtime provider contracts', () => {
  it('match their provider implementations', () => {
    for (const provider of listProviderNames().filter(hasDeclaredProviderRuntimeContract)) {
      expect(() => createProvider(provider)).not.toThrow();
    }
  });
});
