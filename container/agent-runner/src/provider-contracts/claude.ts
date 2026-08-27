import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  resolveClaudeExecutionPolicy,
  resolveClaudeInference,
  resolveClaudeMcpServers,
  resolveClaudeMemoryRuntime,
} from '../providers/claude-config.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';

import {
  registerProviderRuntimeContract,
  type RuntimeFileTransformInput,
  type RuntimeFileTransformResult,
  type RuntimeMemoryHookInput,
} from './registry.js';

const provider = 'claude';

registerProviderRuntimeContract(provider, {
  managedFiles: [
    {
      id: 'memory-session-hook',
      root: claudeConfigDirectory,
      relativePath: 'settings.json',
      when: 'memory-session-hook-registration',
      read: 'text-if-present',
      write: 'direct-replace',
      transform: memorySessionHookTransform,
    },
  ],
  configuration: {
    executionPolicy: { resolve: resolveClaudeExecutionPolicy },
    inference: { resolve: resolveClaudeInference },
    memory: {
      sections: [{ managedFile: 'memory-session-hook', render: (hook) => hook }],
      resolve: resolveClaudeMemoryRuntime,
    },
    mcpServers: { resolve: resolveClaudeMcpServers },
  },
  archives: { trigger: 'pre-compact', plan: planTranscriptArchive },
  continuationRotation: {
    plan: planContinuationRotation,
    root: claudeConfigDirectory,
    searchSubdirectory: 'projects',
    extension: '.jsonl',
  },
  traceReaders: [{ id: 'claude-home', read: newestClaudeTranscript }],
  textDelivery: 'mid-turn-complete',
  compaction: 'provider-hook',
  commands: {
    formatting: 'native',
    nativeAdmin: ['/remote-control', '/compact', '/context', '/cost', '/files'],
    nativeFiltered: ['/help', '/login', '/logout', '/doctor', '/config', '/start'],
  },
});

function memorySessionHookTransform(input: RuntimeFileTransformInput): RuntimeFileTransformResult {
  const hook = input.sections.memory as RuntimeMemoryHookInput | undefined;
  if (!hook) throw new Error(`${input.filePath} requires the rendered memory section`);
  const parsed: unknown = input.exists ? JSON.parse(input.content) : {};
  if (!isRecord(parsed)) throw new Error(`${input.filePath} must contain a JSON object`);

  const hooks = parsed.hooks === undefined ? {} : parsed.hooks;
  if (!isRecord(hooks)) throw new Error(`${input.filePath} hooks must be a JSON object`);

  const sessionStart = hooks.SessionStart === undefined ? [] : hooks.SessionStart;
  if (!Array.isArray(sessionStart)) throw new Error(`${input.filePath} hooks.SessionStart must be an array`);

  const memoryCommands = new Set([hook.command, ...hook.legacyCommands]);
  const nextSessionStart = sessionStart
    .map((entry) => removeMemoryCommands(entry, memoryCommands))
    .filter((entry) => entry !== undefined);
  nextSessionStart.push({
    matcher: hook.sources.join('|'),
    hooks: [{ type: 'command', command: hook.command, timeout: 10 }],
  });

  hooks.SessionStart = nextSessionStart;
  parsed.hooks = hooks;
  return { kind: 'replace', content: JSON.stringify(parsed, null, 2) + '\n' };
}

function newestClaudeTranscript(): string | null {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let best: { path: string; mtimeMs: number } | null = null;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(projects, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const candidate = path.join(projects, dir, file);
      const mtimeMs = fs.statSync(candidate).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
    }
  }
  return best?.path ?? null;
}

interface TranscriptArchiveInput {
  transcriptContent: string;
  sessionsIndexContent?: string;
  sessionId?: string;
  assistantName?: string;
  clockMs: {
    beforeDirectory: readonly number[];
    afterDirectory: readonly number[];
  };
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function planTranscriptArchive(value: unknown): {
  relativePath: string;
  content: string;
  write: 'replace';
  clockSamples?: { beforeDirectory: number; afterDirectory: number };
} | null {
  const input = value as TranscriptArchiveInput;
  const messages = parseTranscript(input.transcriptContent);
  if (messages.length === 0) return null;

  let summary: string | undefined;
  if (input.sessionsIndexContent) {
    try {
      const index = JSON.parse(input.sessionsIndexContent);
      summary = index.entries?.find(
        (entry: { sessionId: string; summary?: string }) => entry.sessionId === input.sessionId,
      )?.summary;
    } catch {
      // Existing behavior ignores malformed session indexes.
    }
  }

  const clockSamples = { beforeDirectory: summary ? 0 : 2, afterDirectory: 2 };
  if (
    input.clockMs.beforeDirectory.length < clockSamples.beforeDirectory ||
    input.clockMs.afterDirectory.length < clockSamples.afterDirectory
  ) {
    return { relativePath: '', content: '', write: 'replace', clockSamples };
  }
  let beforeDirectoryClockIndex = 0;
  const name = summary
    ? summary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
    : `conversation-${new Date(input.clockMs.beforeDirectory[beforeDirectoryClockIndex++])
        .getHours()
        .toString()
        .padStart(2, '0')}${new Date(input.clockMs.beforeDirectory[beforeDirectoryClockIndex++])
        .getMinutes()
        .toString()
        .padStart(2, '0')}`;
  const filenameDate = new Date(input.clockMs.afterDirectory[0]);
  const headerDate = new Date(input.clockMs.afterDirectory[1]);
  return {
    relativePath: `${formatLocalStamp(filenameDate, TIMEZONE).slice(0, 10)}-${name}.md`,
    content: formatTranscriptMarkdown(messages, summary, input.assistantName, headerDate),
    write: 'replace',
  };
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((part: { text?: string }) => part.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter((part: { type: string }) => part.type === 'text')
          .map((part: { text: string }) => part.text)
          .join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Existing behavior skips malformed transcript lines.
    }
  }
  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title: string | undefined,
  assistantName: string | undefined,
  now: Date,
): string {
  const date = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${date}`, '', '---', ''];
  for (const message of messages) {
    const sender = message.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = message.content.length > 2000 ? `${message.content.slice(0, 2000)}...` : message.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

interface ContinuationRotationInput {
  size: number;
  firstLine: string;
  nowMs?: number;
  environment: Record<string, string | undefined>;
}

function planContinuationRotation(value: unknown): { reason?: string; clockSamples?: 1 } | null {
  const input = value as ContinuationRotationInput;
  const maxBytes = Number(input.environment.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
  const rawDays = input.environment.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  const days = rawDays === undefined || rawDays.trim() === '' ? 14 : Number(rawDays);
  const maxAgeMs = !Number.isFinite(days) ? 14 * 86_400_000 : days > 0 ? days * 86_400_000 : Infinity;
  let startMs: number | null = null;
  try {
    const timestamp = JSON.parse(input.firstLine)?.timestamp;
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    if (!Number.isNaN(parsed)) startMs = parsed;
  } catch {
    // Existing behavior ignores unreadable first entries.
  }

  if (startMs !== null && input.nowMs === undefined) return { clockSamples: 1 };
  const ageMs = startMs === null ? 0 : input.nowMs! - startMs;
  if (input.size > maxBytes) {
    return {
      reason: `transcript ${(input.size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`,
    };
  }
  if (startMs !== null && ageMs > maxAgeMs) {
    return {
      reason: `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`,
    };
  }
  return null;
}

function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

function removeMemoryCommands(value: unknown, commands: ReadonlySet<string>): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const hooks = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !commands.has(hook.command);
  });
  return hooks.length > 0 ? { ...value, hooks } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
