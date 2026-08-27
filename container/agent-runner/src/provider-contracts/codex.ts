import path from 'path';

import {
  codexExecutionPolicySection,
  codexInferenceSection,
  codexMcpServersSection,
  codexMemorySection,
  reconcileCodexHooksJson,
  renderCodexConfigToml,
  type CodexConfigPlan,
  type CodexMemorySessionHook,
} from '../providers/codex-app-server.js';
import { planProviderExchangeArchive } from '../providers/exchange-archive.js';
import type { ProviderExchange } from '../providers/types.js';

import {
  registerProviderRuntimeContract,
  type RuntimeFileTransformInput,
  type RuntimeFileTransformResult,
} from './registry.js';

const provider = 'codex';

function codexConfigDirectory(): string {
  return path.join(process.env.HOME || '/home/node', '.codex');
}

/**
 * config.toml is assembled exclusively from the rendered capability sections:
 * every one of the four configuration responsibilities must arrive, so a
 * capability that stops rendering breaks this transform loudly instead of
 * silently dropping its part of the file.
 */
function configTomlTransform(input: RuntimeFileTransformInput): RuntimeFileTransformResult {
  const { sections } = input;
  if (!sections.executionPolicy || !sections.inference || !sections.memory || !sections.mcpServers) {
    throw new Error(`${input.filePath} requires all four rendered configuration sections`);
  }
  const plan: CodexConfigPlan = {
    executionPolicy: sections.executionPolicy as CodexConfigPlan['executionPolicy'],
    inference: sections.inference as CodexConfigPlan['inference'],
    memory: sections.memory as CodexConfigPlan['memory'],
    mcpServers: sections.mcpServers as CodexConfigPlan['mcpServers'],
  };
  return { kind: 'replace', content: renderCodexConfigToml(plan) };
}

function memoryHooksTransform(input: RuntimeFileTransformInput): RuntimeFileTransformResult {
  const hook = input.sections.memory as CodexMemorySessionHook | undefined;
  if (!hook) throw new Error(`${input.filePath} requires the rendered memory section`);
  return {
    kind: 'replace',
    content: reconcileCodexHooksJson(input.content, hook, input.filePath, input.exists),
  };
}

registerProviderRuntimeContract(provider, {
  managedFiles: [
    {
      id: 'config-toml',
      root: codexConfigDirectory,
      relativePath: 'config.toml',
      when: 'before-query',
      read: 'none',
      write: 'direct-replace',
      transform: configTomlTransform,
    },
    {
      id: 'memory-hooks',
      root: codexConfigDirectory,
      relativePath: 'hooks.json',
      when: 'before-query',
      read: 'text-if-present',
      write: 'direct-replace',
      transform: memoryHooksTransform,
    },
  ],
  configuration: {
    executionPolicy: {
      sections: [{ managedFile: 'config-toml', render: codexExecutionPolicySection }],
    },
    inference: {
      sections: [{ managedFile: 'config-toml', render: codexInferenceSection }],
    },
    // Memory spans both files: config.toml keeps Codex's native memory
    // disabled (NanoClaw owns persistent memory) while hooks.json carries the
    // shared session hook that injects it.
    memory: {
      sections: [
        { managedFile: 'config-toml', render: codexMemorySection },
        { managedFile: 'memory-hooks', render: (hook) => hook },
      ],
    },
    mcpServers: {
      sections: [{ managedFile: 'config-toml', render: codexMcpServersSection }],
    },
  },
  archives: { trigger: 'exchange-complete', plan: planExchangeArchive },
  traceReaders: [],
  textDelivery: 'result',
  commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
});

function planExchangeArchive(value: unknown): { relativePath: string; content: string; write: 'append' } | null {
  const { exchange, entries, nowMs, targetExists } = value as {
    exchange: ProviderExchange;
    entries: string[];
    nowMs: number;
    targetExists?: boolean;
  };
  return planProviderExchangeArchive({
    provider,
    prompt: exchange.prompt,
    result: exchange.result,
    continuation: exchange.continuation,
    status: exchange.status,
    timestamp: new Date(nowMs),
    entries,
    targetExists,
  });
}
