import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';
import { registerProvider } from './provider-registry.js';
import { registerProviderRuntimeContract } from '../provider-contracts/registry.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });

  it('executes core-owned work without calling provider fallbacks', () => {
    const name = `factory-core-owner-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversations = path.join(root, 'conversations');
    const projects = path.join(root, 'projects', 'workspace');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, 'session.jsonl'), '{}\n');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversations;
    let fallbackCalls = 0;
    let exchangePlannerCalls = 0;

    registerProvider(name, () => ({
      supportsNativeSlashCommands: false,
      registerMemorySessionHook: () => {},
      onExchangeComplete: () => fallbackCalls++,
      maybeRotateContinuation: () => {
        fallbackCalls++;
        return null;
      },
      query: () => {
        throw new Error('unused');
      },
      isSessionInvalid: () => false,
    }));
    registerProviderRuntimeContract(name, {
      managedFiles: [],
      configuration: {
        executionPolicy: { resolve: () => ({ boundary: 'container' }) },
        inference: { resolve: (input) => ({ model: input.model }) },
        memory: { resolve: (input) => ({ command: input.command }) },
        mcpServers: { resolve: (input) => ({ servers: Object.keys(input) }) },
      },
      archives: {
        trigger: 'exchange-complete',
        plan: (input) => {
          if (!('exchange' in (input as object))) return null;
          exchangePlannerCalls++;
          return { relativePath: 'exchange.md', content: 'archived\n', write: 'replace' };
        },
      },
      continuationRotation: {
        plan: () => ({ reason: 'rotate' }),
        root: () => root,
        searchSubdirectory: 'projects',
        extension: '.jsonl',
      },
      traceReaders: [],
      textDelivery: 'result',
      commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
    });

    try {
      const provider = createProvider(name);
      provider.onExchangeComplete?.({ prompt: 'hello', result: 'world', status: 'completed' });
      const archiveCalls = exchangePlannerCalls;
      expect(provider.maybeRotateContinuation?.('session', '/unused')).toBe('rotate');
      expect(fs.readFileSync(path.join(conversations, 'exchange.md'), 'utf8')).toBe('archived\n');
      expect(exchangePlannerCalls).toBe(archiveCalls);
      expect(fallbackCalls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
