import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, spyOn } from 'bun:test';

import './index.js';
import type { AgentProvider } from '../providers/types.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import {
  archiveProviderExchangeFromContract,
  archiveProviderTranscript,
  newestRegisteredTrace,
  realizeProviderManagedFiles,
} from './realize.js';
import {
  getProviderRuntimeContract,
  hasDeclaredProviderRuntimeContract,
  registerProviderRuntimeContract,
  type ProviderRuntimeContract,
  type RuntimeArchivePlanner,
  type RuntimeManagedFile,
  validateProviderRuntimeInstance,
} from './registry.js';

function emptyContract(): ProviderRuntimeContract {
  return {
    managedFiles: [],
    configuration: {
      executionPolicy: { resolve: () => ({ boundary: 'container' }) },
      inference: { resolve: (input) => ({ model: input.model, effort: input.effort }) },
      memory: { resolve: (input) => ({ command: input.command }) },
      mcpServers: { resolve: (input) => ({ servers: Object.keys(input) }) },
    },
    traceReaders: [],
    textDelivery: 'result',
    commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
  };
}

function coreArchiveContract(
  trigger: 'pre-compact' | 'exchange-complete',
  plan: RuntimeArchivePlanner,
): ProviderRuntimeContract {
  return {
    ...emptyContract(),
    archives: { trigger, plan },
    ...(trigger === 'pre-compact' ? { compaction: 'provider-hook' as const } : {}),
  };
}

function managedFile(overrides: Partial<RuntimeManagedFile>): RuntimeManagedFile {
  return {
    id: 'settings',
    root: () => '/tmp',
    relativePath: 'settings.json',
    when: 'before-query',
    read: 'none',
    write: 'direct-replace',
    transform: ({ sections }) => ({ kind: 'replace', content: JSON.stringify(sections) + '\n' }),
    ...overrides,
  };
}

function contractName(field: string, suffix: string): string {
  return `runtime-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

function runtimeInstance(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    registerMemorySessionHook: () => {},
    query: () => {
      throw new Error('unused');
    },
    isSessionInvalid: () => false,
    ...overrides,
  };
}

describe('provider runtime contracts', () => {
  it('loads the complete Claude implementation from the separate contract barrel', () => {
    const contract = getProviderRuntimeContract('claude');
    expect(contract).toBeDefined();
    expect(contract?.managedFiles).toHaveLength(1);
    const settings = contract!.managedFiles[0];
    expect(settings.id).toBe('memory-session-hook');
    expect(settings.relativePath).toBe('settings.json');
    expect(settings.when).toBe('memory-session-hook-registration');
    expect(settings.read).toBe('text-if-present');
    expect(settings.write).toBe('direct-replace');
    expect(typeof settings.root).toBe('function');
    expect(typeof settings.transform).toBe('function');

    expect(typeof contract?.configuration.executionPolicy.resolve).toBe('function');
    expect(contract?.configuration.executionPolicy.sections).toBeUndefined();
    expect(typeof contract?.configuration.inference.resolve).toBe('function');
    expect(typeof contract?.configuration.mcpServers.resolve).toBe('function');
    expect(contract?.configuration.memory.sections).toHaveLength(1);
    expect(contract?.configuration.memory.sections?.[0].managedFile).toBe('memory-session-hook');
    expect(typeof contract?.configuration.memory.resolve).toBe('function');

    expect(contract?.archives?.trigger).toBe('pre-compact');
    expect(typeof contract?.archives?.plan).toBe('function');
    expect(contract?.continuationRotation?.searchSubdirectory).toBe('projects');
    expect(contract?.continuationRotation?.extension).toBe('.jsonl');
    expect(contract?.traceReaders.map((trace) => trace.id)).toEqual(['claude-home']);
    expect(contract?.textDelivery).toBe('mid-turn-complete');
    expect(contract?.compaction).toBe('provider-hook');
    expect(contract?.commands.formatting).toBe('native');
    expect(hasDeclaredProviderRuntimeContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderRuntimeContract('legacy')).toBe(false);
  });

  it('resolves Claude execution policy, inference, and MCP config through the contract functions', () => {
    const contract = getProviderRuntimeContract('claude')!;
    const policy = contract.configuration.executionPolicy.resolve!(undefined, {}) as {
      permissionMode: string;
      disallowedTools: string[];
    };
    expect(policy.permissionMode).toBe('bypassPermissions');
    expect(policy.disallowedTools).toContain('AskUserQuestion');

    const inference = contract.configuration.inference.resolve!({ model: 'opus', effort: 'high' }, {});
    expect(inference).toEqual({ model: 'opus', effort: 'high' });

    const mcp = contract.configuration.mcpServers.resolve!({ nanoclaw: { command: 'bun' } }, {}) as {
      allowedTools: string[];
    };
    expect(mcp.allowedTools).toContain('mcp__nanoclaw__*');
  });

  it('rejects duplicate registrations', () => {
    const name = `runtime-contract-${process.pid}`;
    registerProviderRuntimeContract(name, emptyContract());
    expect(() => registerProviderRuntimeContract(name, emptyContract())).toThrow(/already registered/);
  });

  it('rejects non-kebab-case provider names', () => {
    expect(() => registerProviderRuntimeContract('Runtime Bad Name', emptyContract())).toThrow(/kebab-case/);
  });

  it('freezes the stored contract so later mutation attempts throw', () => {
    const name = `runtime-immutable-${process.pid}`;
    registerProviderRuntimeContract(name, emptyContract());
    const stored = getProviderRuntimeContract(name)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands.nativeAdmin)).toBe(true);
    expect(() => (stored.commands.nativeAdmin as string[]).push('/later')).toThrow();
  });

  it('rejects capabilities without any implementation surface', () => {
    const contract = emptyContract();
    contract.configuration.inference = {};
    expect(() => registerProviderRuntimeContract(contractName('configuration-empty', 'invalid'), contract)).toThrow(
      /configuration\.inference must implement at least one surface/,
    );
  });

  it('rejects a missing configuration block and missing capabilities', () => {
    const missingBlock = emptyContract() as unknown as { configuration?: unknown };
    delete missingBlock.configuration;
    expect(() =>
      registerProviderRuntimeContract(
        contractName('configuration-block', 'missing'),
        missingBlock as ProviderRuntimeContract,
      ),
    ).toThrow(/configuration is required/);

    const missingCapability = emptyContract() as unknown as {
      configuration: Record<string, unknown>;
    };
    delete missingCapability.configuration.memory;
    expect(() =>
      registerProviderRuntimeContract(
        contractName('configuration-memory', 'missing'),
        missingCapability as unknown as ProviderRuntimeContract,
      ),
    ).toThrow(/configuration\.memory is required/);
  });

  it('rejects sections that reference missing managed files', () => {
    const contract = emptyContract();
    contract.configuration.memory = {
      sections: [{ managedFile: 'missing-file', render: (hook) => hook }],
    };
    expect(() => registerProviderRuntimeContract(contractName('configuration-file', 'missing'), contract)).toThrow(
      /configuration\.memory references missing managed file 'missing-file'/,
    );
  });

  it('rejects managed files with non-function surfaces and invalid enums', () => {
    const base = emptyContract();
    expect(() =>
      registerProviderRuntimeContract(contractName('managed-transform', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ transform: 'invalid' as unknown as RuntimeManagedFile['transform'] })],
      }),
    ).toThrow(/managedFiles\.settings\.transform must be a function/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-root', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ root: 'invalid' as unknown as RuntimeManagedFile['root'] })],
      }),
    ).toThrow(/managedFiles\.settings\.root must be a function/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-when', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ when: 'invalid' as RuntimeManagedFile['when'] })],
      }),
    ).toThrow(/managedFiles\.settings\.when/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-read', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ read: 'invalid' as RuntimeManagedFile['read'] })],
      }),
    ).toThrow(/managedFiles\.settings\.read/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-write', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ write: 'invalid' as RuntimeManagedFile['write'] })],
      }),
    ).toThrow(/managedFiles\.settings\.write/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-duplicate', 'invalid'), {
        ...base,
        managedFiles: [managedFile({}), managedFile({ relativePath: 'other.json' })],
      }),
    ).toThrow(/managedFiles\[\]\.id must be unique/);
  });

  it.each([
    ['dot', './settings.json'],
    ['bare-parent', '..'],
    ['leading-parent', '../settings.json'],
    ['parent', 'config/../settings.json'],
    ['slash', 'config//settings.json'],
    ['trailing', 'config/'],
  ])('rejects noncanonical managed-file relative path %s', (label, relativePath) => {
    expect(() =>
      registerProviderRuntimeContract(contractName('managed-relative-path', label), {
        ...emptyContract(),
        managedFiles: [managedFile({ relativePath })],
      }),
    ).toThrow(/canonical relative path/);
  });

  it('rejects invalid text delivery, compaction, and command declarations', () => {
    expect(() =>
      registerProviderRuntimeContract(contractName('text-delivery', 'invalid'), {
        ...emptyContract(),
        textDelivery: 'invalid' as ProviderRuntimeContract['textDelivery'],
      }),
    ).toThrow(/textDelivery/);

    expect(() =>
      registerProviderRuntimeContract(contractName('compaction', 'invalid'), {
        ...emptyContract(),
        compaction: 'invalid' as ProviderRuntimeContract['compaction'],
      }),
    ).toThrow(/compaction/);

    expect(() =>
      registerProviderRuntimeContract(contractName('commands-formatting', 'invalid'), {
        ...emptyContract(),
        commands: { formatting: 'invalid' as 'xml', nativeAdmin: [], nativeFiltered: [] },
      }),
    ).toThrow(/commands\.formatting/);

    expect(() =>
      registerProviderRuntimeContract(contractName('commands-native', 'invalid'), {
        ...emptyContract(),
        commands: { formatting: 'xml', nativeAdmin: ['bad command'], nativeFiltered: [] },
      }),
    ).toThrow(/commands\.nativeAdmin/);
  });

  it('rejects a pre-compact archive without a provider-hook compaction', () => {
    expect(() =>
      registerProviderRuntimeContract(contractName('archives-compaction', 'invalid'), {
        ...emptyContract(),
        archives: { trigger: 'pre-compact', plan: () => null },
      }),
    ).toThrow(/pre-compact trigger requires compaction 'provider-hook'/);
  });

  it('rejects invalid continuation-rotation declarations', () => {
    expect(() =>
      registerProviderRuntimeContract(contractName('rotation-extension', 'invalid'), {
        ...emptyContract(),
        continuationRotation: {
          plan: () => null,
          root: () => '/tmp',
          searchSubdirectory: 'projects',
          extension: 'jsonl',
        },
      }),
    ).toThrow(/extension must be a file extension/);
  });

  describe('registration probes', () => {
    it('rejects a section the managed file transform ignores', () => {
      const contract = emptyContract();
      contract.managedFiles = [
        managedFile({
          transform: ({ sections }) => ({
            kind: 'replace',
            content: JSON.stringify({ memory: sections.memory }) + '\n',
          }),
        }),
      ];
      contract.configuration.memory = {
        sections: [{ managedFile: 'settings', render: (hook) => hook }],
      };
      contract.configuration.inference = {
        sections: [{ managedFile: 'settings', render: (input) => input }],
      };
      expect(() => registerProviderRuntimeContract(contractName('probe-dead-section', 'invalid'), contract)).toThrow(
        /configuration\.inference section does not affect managed file 'settings'/,
      );
    });

    it('rejects a capability that ignores its configuration input', () => {
      const contract = emptyContract();
      contract.configuration.inference = { resolve: () => ({ constant: true }) };
      expect(() => registerProviderRuntimeContract(contractName('probe-insensitive', 'invalid'), contract)).toThrow(
        /configuration\.inference does not respond to its configuration input/,
      );
    });

    it('rejects a resolve that produces no value', () => {
      const contract = emptyContract();
      contract.configuration.executionPolicy = { resolve: () => undefined };
      expect(() => registerProviderRuntimeContract(contractName('probe-undefined', 'invalid'), contract)).toThrow(
        /configuration\.executionPolicy\.resolve must produce a value/,
      );
    });

    it('rejects a bound managed file whose transform cannot produce initial content', () => {
      const contract = emptyContract();
      contract.managedFiles = [managedFile({ transform: () => ({ kind: 'unchanged' }) })];
      contract.configuration.memory = {
        sections: [{ managedFile: 'settings', render: (hook) => hook }],
      };
      expect(() => registerProviderRuntimeContract(contractName('probe-unchanged', 'invalid'), contract)).toThrow(
        /transform must produce content from an empty state/,
      );
    });

    it('honors declared probe fixtures and probe environments', () => {
      const seenEnvironments: Array<Record<string, string | undefined>> = [];
      const effortOnly = (input: { model?: string; effort?: string }, environment: NodeJS.ProcessEnv): unknown => {
        seenEnvironments.push({ ...environment });
        return { effort: input.effort ?? 'none' };
      };

      const withoutProbes = emptyContract();
      withoutProbes.configuration.inference = { resolve: effortOnly };
      expect(() =>
        registerProviderRuntimeContract(contractName('probe-defaults-miss', 'invalid'), withoutProbes),
      ).toThrow(/configuration\.inference does not respond/);

      const withProbes = emptyContract();
      withProbes.configuration.inference = {
        resolve: effortOnly,
        probes: { a: { effort: 'low' }, b: { effort: 'high' }, environment: { NANOCLAW_PROBE: 'set' } },
      };
      registerProviderRuntimeContract(contractName('probe-defaults-hit', 'valid'), withProbes);
      expect(seenEnvironments.at(-1)?.NANOCLAW_PROBE).toBe('set');
    });

    it('accepts a capability whose sensitivity lives in a section while its resolve is constant', () => {
      const contract = emptyContract();
      contract.managedFiles = [
        managedFile({
          transform: ({ sections }) => {
            if (!sections.memory) throw new Error('memory section required');
            return { kind: 'replace', content: JSON.stringify(sections.memory) + '\n' };
          },
        }),
      ];
      contract.configuration.memory = {
        sections: [{ managedFile: 'settings', render: (hook) => hook }],
        resolve: () => ({ disabled: true }),
      };
      registerProviderRuntimeContract(contractName('probe-section-sensitive', 'valid'), contract);
    });
  });

  it('validates instance surfaces in both directions', () => {
    const formattingName = contractName('instance-formatting', 'invalid');
    registerProviderRuntimeContract(formattingName, {
      ...emptyContract(),
      commands: { formatting: 'native', nativeAdmin: [], nativeFiltered: [] },
    });
    expect(() =>
      validateProviderRuntimeInstance(formattingName, getProviderRuntimeContract(formattingName)!, runtimeInstance()),
    ).toThrow(/commands\.formatting/);

    const textName = contractName('instance-text', 'invalid');
    registerProviderRuntimeContract(textName, { ...emptyContract(), textDelivery: 'mid-turn-complete' });
    expect(() =>
      validateProviderRuntimeInstance(textName, getProviderRuntimeContract(textName)!, runtimeInstance()),
    ).toThrow(/textDelivery/);

    const exchangeDeclared = contractName('instance-exchange-declared', 'invalid');
    registerProviderRuntimeContract(exchangeDeclared, coreArchiveContract('exchange-complete', () => null));
    expect(() =>
      validateProviderRuntimeInstance(
        exchangeDeclared,
        getProviderRuntimeContract(exchangeDeclared)!,
        runtimeInstance(),
      ),
    ).toThrow(/exchange-complete archives do not match onExchangeComplete/);

    const exchangeUndeclared = contractName('instance-exchange-undeclared', 'invalid');
    registerProviderRuntimeContract(exchangeUndeclared, emptyContract());
    expect(() =>
      validateProviderRuntimeInstance(
        exchangeUndeclared,
        getProviderRuntimeContract(exchangeUndeclared)!,
        runtimeInstance({ onExchangeComplete: () => {} }),
      ),
    ).toThrow(/exchange-complete archives do not match onExchangeComplete/);

    const rotationDeclared = contractName('instance-rotation-declared', 'invalid');
    registerProviderRuntimeContract(rotationDeclared, {
      ...emptyContract(),
      continuationRotation: {
        plan: () => null,
        root: () => '/tmp',
        searchSubdirectory: 'projects',
        extension: '.jsonl',
      },
    });
    expect(() =>
      validateProviderRuntimeInstance(
        rotationDeclared,
        getProviderRuntimeContract(rotationDeclared)!,
        runtimeInstance(),
      ),
    ).toThrow(/continuationRotation does not match maybeRotateContinuation/);

    const rotationUndeclared = contractName('instance-rotation-undeclared', 'invalid');
    registerProviderRuntimeContract(rotationUndeclared, emptyContract());
    expect(() =>
      validateProviderRuntimeInstance(
        rotationUndeclared,
        getProviderRuntimeContract(rotationUndeclared)!,
        runtimeInstance({ maybeRotateContinuation: () => null }),
      ),
    ).toThrow(/continuationRotation does not match maybeRotateContinuation/);
  });

  it('honors managed-file read policy and preserves config-before-hooks failure ordering', () => {
    const name = `runtime-managed-files-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const configPath = path.join(root, 'config.toml');
    const hooksPath = path.join(root, 'hooks.json');
    const calls: string[] = [];
    const originalExistsSync = fs.existsSync.bind(fs);

    registerProviderRuntimeContract(name, {
      ...emptyContract(),
      managedFiles: [
        managedFile({
          id: 'config',
          root: () => root,
          relativePath: 'config.toml',
          read: 'none',
          transform: ({ exists, content }) => {
            calls.push(`config:${exists}:${content}`);
            return { kind: 'replace', content: 'new config\n' };
          },
        }),
        managedFile({
          id: 'hooks',
          root: () => root,
          relativePath: 'hooks.json',
          read: 'text-if-present',
          transform: ({ exists, content }) => {
            calls.push(`hooks:${exists}:${content}`);
            JSON.parse(content || '{}');
            return { kind: 'replace', content: '{"hooks":true}\n' };
          },
        }),
      ],
    });

    try {
      fs.writeFileSync(configPath, 'stale config');
      fs.writeFileSync(hooksPath, '{}');
      const mkdirSpy = spyOn(fs, 'mkdirSync');
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation((candidate) => {
        if (candidate === configPath) throw new Error('config existence must not be checked');
        return originalExistsSync(candidate);
      });
      try {
        realizeProviderManagedFiles(name, 'before-query');
        expect(mkdirSpy).toHaveBeenCalledTimes(1);
      } finally {
        existsSpy.mockRestore();
        mkdirSpy.mockRestore();
      }
      expect(calls).toEqual(['config:false:', 'hooks:true:{}']);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('new config\n');
      expect(fs.readFileSync(hooksPath, 'utf-8')).toBe('{"hooks":true}\n');

      calls.length = 0;
      fs.writeFileSync(configPath, 'stale again');
      fs.writeFileSync(hooksPath, '{');
      expect(() => realizeProviderManagedFiles(name, 'before-query')).toThrow();
      expect(calls).toEqual(['config:false:', 'hooks:true:{']);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('new config\n');
      expect(fs.readFileSync(hooksPath, 'utf-8')).toBe('{');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('decides empty transcript no-op before reading the optional sessions index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-noop-${process.pid}-`));
    const transcriptPath = path.join(root, 'empty.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '');

    try {
      expect(archiveProviderTranscript('claude', transcriptPath, 'empty', 'Claude', () => {})).toBe(false);
      fs.mkdirSync(path.join(root, 'sessions-index.json'));
      const logs: string[] = [];
      expect(archiveProviderTranscript('claude', transcriptPath, 'empty', 'Claude', (line) => logs.push(line))).toBe(
        false,
      );
      expect(logs).toEqual([]);
      expect(fs.existsSync(conversationsDir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('samples Claude clocks around mkdir and uses the local filename date across UTC rollover', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-clock-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const indexPath = path.join(root, 'sessions-index.json');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    const beforeDirectoryClockMs = [Date.parse('2026-01-01T23:59:59.900Z'), Date.parse('2026-01-02T00:00:00.100Z')];
    const utcRolloverClockMs = [Date.parse('2027-02-03T23:59:59.900Z'), Date.parse('2027-02-04T00:00:00.100Z')];
    const filenameClockMs =
      utcRolloverClockMs.find(
        (clockMs) =>
          formatLocalStamp(new Date(clockMs), TIMEZONE).slice(0, 10) !== new Date(clockMs).toISOString().slice(0, 10),
      ) ?? utcRolloverClockMs[0];
    const afterDirectoryClockMs = [filenameClockMs, Date.parse('2027-02-04T00:00:00.100Z')];
    let beforeDirectoryClockIndex = 0;
    let afterDirectoryClockIndex = 0;
    let indexRead = false;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{}');
    fs.writeFileSync(indexPath, '{}');
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation((candidate) => {
      if (candidate === transcriptPath) return '{"type":"user","message":{"content":"hello"}}\n';
      if (candidate === indexPath) {
        indexRead = true;
        return '{"entries":[]}';
      }
      throw new Error(`unexpected read: ${String(candidate)}`);
    });
    const mkdirSpy = spyOn(fs, 'mkdirSync');
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
      expect(indexRead).toBe(true);
      return mkdirSpy.mock.calls.length === 0
        ? beforeDirectoryClockMs[beforeDirectoryClockIndex++]
        : afterDirectoryClockMs[afterDirectoryClockIndex++];
    });

    try {
      try {
        expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', () => {})).toBe(true);
      } finally {
        readSpy.mockRestore();
        nowSpy.mockRestore();
        mkdirSpy.mockRestore();
      }
      const hour = new Date(beforeDirectoryClockMs[0]).getHours().toString().padStart(2, '0');
      const minute = new Date(beforeDirectoryClockMs[1]).getMinutes().toString().padStart(2, '0');
      const localDate = formatLocalStamp(new Date(afterDirectoryClockMs[0]), TIMEZONE).slice(0, 10);
      const filename = `${localDate}-conversation-${hour}${minute}.md`;
      const archived = fs.readFileSync(path.join(conversationsDir, filename), 'utf-8');
      const header = new Date(afterDirectoryClockMs[1]).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      expect(archived).toContain(`Archived: ${header}`);
      expect(beforeDirectoryClockIndex).toBe(2);
      expect(afterDirectoryClockIndex).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses zero pre-mkdir clocks for a summarized Claude transcript', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-summary-clock-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.writeFileSync(
      path.join(root, 'sessions-index.json'),
      '{"entries":[{"sessionId":"session","summary":"Useful Summary"}]}',
    );
    const mkdirSpy = spyOn(fs, 'mkdirSync');
    const clockMs = [Date.parse('2027-03-04T23:59:59.900Z'), Date.parse('2027-03-05T00:00:00.100Z')];
    let clockIndex = 0;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
      expect(mkdirSpy).toHaveBeenCalledTimes(1);
      return clockMs[clockIndex++];
    });

    try {
      try {
        expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', () => {})).toBe(true);
      } finally {
        nowSpy.mockRestore();
        mkdirSpy.mockRestore();
      }
      expect(clockIndex).toBe(2);
      expect(fs.readdirSync(conversationsDir)).toEqual(['2027-03-04-useful-summary.md']);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('consumes only Claude fallback clocks when conversations mkdir fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-mkdir-clock-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'not-a-directory');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.writeFileSync(conversationsDir, 'blocked');
    const nowSpy = spyOn(Date, 'now').mockReturnValue(100);

    try {
      const logs: string[] = [];
      expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', (line) => logs.push(line))).toBe(
        false,
      );
      expect(nowSpy).toHaveBeenCalledTimes(2);
      expect(logs[0]).toContain('Failed to archive transcript:');
    } finally {
      nowSpy.mockRestore();
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('archives a transcript without a summary when the optional sessions index is unreadable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-index-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.mkdirSync(path.join(root, 'sessions-index.json'));

    try {
      expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', () => {})).toBe(true);
      const [archive] = fs.readdirSync(conversationsDir);
      expect(fs.readFileSync(path.join(conversationsDir, archive), 'utf-8')).toContain('**User**: hello');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('decides empty exchange no-op before conversations discovery', () => {
    const name = `runtime-exchange-noop-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', (value) => {
        const exchange = (value as { exchange: { result: string | null } }).exchange;
        return exchange.result?.trim()
          ? { relativePath: 'exchange.md', content: exchange.result, write: 'append' }
          : null;
      }),
    );
    const nowSpy = spyOn(Date, 'now');
    const mkdirSpy = spyOn(fs, 'mkdirSync');
    const readdirSpy = spyOn(fs, 'readdirSync');

    try {
      const empty = { prompt: 'hello', result: ' ', status: 'completed' as const };
      expect(archiveProviderExchangeFromContract(name, empty)).toBeNull();
      expect(fs.existsSync(conversationsDir)).toBe(false);
      fs.writeFileSync(conversationsDir, 'not a directory');
      expect(archiveProviderExchangeFromContract(name, empty)).toBeNull();
      expect(nowSpy).toHaveBeenCalledTimes(0);
      expect(mkdirSpy).toHaveBeenCalledTimes(0);
      expect(readdirSpy).toHaveBeenCalledTimes(0);
    } finally {
      nowSpy.mockRestore();
      mkdirSpy.mockRestore();
      readdirSpy.mockRestore();
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates the archive directory after the empty probe and reuses one clock reading', () => {
    const name = `runtime-exchange-order-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    const calls: Array<{ directoryExists: boolean; nowMs: number; targetExists?: boolean }> = [];
    let clock = 200;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => ++clock);
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', (value) => {
        const input = value as { nowMs: number; targetExists?: boolean };
        calls.push({
          directoryExists: fs.existsSync(conversationsDir),
          nowMs: input.nowMs,
          ...(input.targetExists === undefined ? {} : { targetExists: input.targetExists }),
        });
        return { relativePath: 'exchange.md', content: 'archive', write: 'append' };
      }),
    );

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(calls).toEqual([
        { directoryExists: false, nowMs: 0, targetExists: false },
        { directoryExists: true, nowMs: 201 },
        { directoryExists: true, nowMs: 201, targetExists: false },
      ]);
      expect(nowSpy).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves mkdir-before-scan errors for non-empty exchange archives', () => {
    const name = `runtime-exchange-error-order-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'not-a-directory');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(conversationsDir, 'blocked');
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', () => ({
        relativePath: 'exchange.md',
        content: 'archive',
        write: 'append',
      })),
    );

    try {
      expect(() =>
        archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' }),
      ).toThrow(/EEXIST/);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows archive targets contained by the filesystem root', () => {
    const name = `runtime-exchange-root-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const target = path.join(root, 'exchange.md');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = path.parse(root).root;
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', () => ({
        relativePath: path.relative(path.parse(root).root, target),
        content: 'archive',
        write: 'append',
      })),
    );

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        path.relative(path.parse(root).root, target),
      );
      expect(fs.readFileSync(target, 'utf-8')).toBe('archive');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes dangling selected-target existence to the archive planner', () => {
    const name = `runtime-exchange-dangling-${process.pid}`;
    const conversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.symlinkSync('archive-target.md', path.join(conversationsDir, 'exchange.md'));
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', (value) => ({
        relativePath: 'exchange.md',
        content: (value as { targetExists?: boolean }).targetExists === false ? 'header\narchive' : 'archive',
        write: 'append',
      })),
    );

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(fs.readFileSync(path.join(conversationsDir, 'archive-target.md'), 'utf-8')).toBe('header\narchive');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it('reads Claude traces from the OS home even when CLAUDE_CONFIG_DIR diverges', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-trace-home-${process.pid}-`));
    const home = path.join(root, 'home');
    const config = path.join(root, 'config');
    const homeTrace = path.join(home, '.claude', 'projects', 'home-project', 'home.jsonl');
    const configTrace = path.join(config, 'projects', 'config-project', 'config.jsonl');
    fs.mkdirSync(path.dirname(homeTrace), { recursive: true });
    fs.mkdirSync(path.dirname(configTrace), { recursive: true });
    fs.writeFileSync(homeTrace, '{}\n');
    fs.writeFileSync(configTrace, '{}\n');
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(home);

    try {
      expect(newestRegisteredTrace()).toBe(homeTrace);
    } finally {
      homedirSpy.mockRestore();
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes a declared exchange archive plan', () => {
    const name = `runtime-exchange-archive-${process.pid}`;
    const conversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', () => ({
        relativePath: 'exchange.md',
        content: 'archived\n',
        write: 'append',
      })),
    );

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(fs.readFileSync(path.join(conversationsDir, 'exchange.md'), 'utf-8')).toBe('archived\n');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(conversationsDir, { recursive: true, force: true });
    }
  });
});
