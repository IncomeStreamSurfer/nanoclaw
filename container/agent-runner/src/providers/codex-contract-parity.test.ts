import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'bun:test';

import { writeCodexConfigToml, type CodexMemorySessionHook } from './codex-app-server.js';
import type { McpServerConfig } from './types.js';

// These tests need the runtime-contract core (registry + realize + factory
// wiring). On the standalone providers branch that core is absent — the
// payload is only ever executed inside an install — so they skip there, the
// same way legacy-payload-compat.test.ts skips absent payloads on core.
const hasContractCore = fs.existsSync(new URL('../provider-contracts/realize.ts', import.meta.url));

const SERVERS: Record<string, McpServerConfig> = {
  nanoclaw: {
    command: 'bun',
    args: ['run', '/app/src/mcp-tools/index.ts'],
    env: { FOO: 'bar' },
  },
  docs: {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { 'X-Api-Version': '2024-06' },
  },
};

const HOOK: CodexMemorySessionHook = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
};

const EXISTING_HOOKS_JSON = JSON.stringify(
  {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'custom-stop' }] }],
      SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] }],
    },
  },
  null,
  2,
);

function seedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parity-'));
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), EXISTING_HOOKS_JSON);
  return home;
}

function readCodexFiles(home: string): { configToml: string; hooksJson: string } {
  return {
    configToml: fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8'),
    hooksJson: fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf-8'),
  };
}

(hasContractCore ? describe : describe.skip)('codex contract write-path parity', () => {
  it('produces byte-identical config.toml and hooks.json through the contract path and the legacy writer', async () => {
    await import('./index.js');
    const { createProvider } = await import('./factory.js');
    const { realizeProviderManagedFiles, registerProviderMemorySessionHook } = await import(
      '../provider-contracts/realize.js'
    );

    const previousHome = process.env.HOME;
    const legacyHome = seedHome();
    const contractHome = seedHome();
    try {
      // Legacy path: the provider normalizes effort in its constructor, then
      // hands the direct writer the normalized value.
      process.env.HOME = legacyHome;
      writeCodexConfigToml(SERVERS, HOOK, { model: 'gpt-5', effort: 'high' });
      const legacy = readCodexFiles(legacyHome);

      // Contract path: core renders each capability from the raw construction
      // options (effort arrives un-normalized) and writes the managed files.
      process.env.HOME = contractHome;
      const provider = createProvider('codex', { mcpServers: SERVERS, model: 'gpt-5', effort: 'HIGH' });
      registerProviderMemorySessionHook('codex', provider, {
        command: HOOK.command,
        legacyCommands: [...HOOK.legacyCommands],
        sources: ['startup', 'clear', 'compact'],
      });
      realizeProviderManagedFiles('codex', 'before-query', provider);
      const contract = readCodexFiles(contractHome);

      expect(contract.configToml).toBe(legacy.configToml);
      expect(contract.hooksJson).toBe(legacy.hooksJson);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(legacyHome, { recursive: true, force: true });
      fs.rmSync(contractHome, { recursive: true, force: true });
    }
  });
});
