import fs from 'fs';
import path from 'path';

import { TIMEZONE, formatLocalStamp } from '../timezone.js';

/**
 * Per-thread conversation archive for providers with no on-disk transcript.
 * The pure plan is shared by the legacy provider writer and new core's
 * contract executor, so the ownership handoff cannot change the output.
 *
 * One file per thread (keyed on the continuation id), named
 * `<date>-<provider>-<thread>.md` and appended to as exchanges complete —
 * mirroring the Claude path's one-file-per-session granularity and its
 * date-prefixed, name-sortable filenames, since the Codex app-server keeps
 * history server-side with no transcript to roll up at a compaction boundary.
 * The date is the thread's creation day and stays stable across later appends.
 */

const DEFAULT_CONVERSATIONS_DIR = '/workspace/agent/conversations';

export interface ProviderExchangeArchiveOptions {
  provider: string;
  prompt: string;
  result: string | null | undefined;
  continuation?: string;
  status: string;
  timestamp?: Date;
  conversationsDir?: string;
}

export interface ProviderExchangeArchivePlan {
  relativePath: string;
  content: string;
  write: 'append';
}

export interface ProviderExchangeArchivePlanInput {
  provider: string;
  prompt: string;
  result: string | null | undefined;
  continuation?: string;
  status: string;
  timestamp: Date;
  entries: readonly string[];
  targetExists?: boolean;
}

/**
 * Append a single prompt/result exchange to its thread's conversation file,
 * writing the thread-level header once when the file is first created. Returns
 * the (thread-stable) filename, or null when there is nothing to archive
 * (empty result).
 */
export function archiveProviderExchange(options: ProviderExchangeArchiveOptions): string | null {
  if (!options.result?.trim()) return null;
  const timestamp = options.timestamp ?? new Date();
  const probe = planProviderExchangeArchive({ ...options, timestamp, entries: [] });
  if (!probe) return null;

  const conversationsDir =
    options.conversationsDir || process.env.NANOCLAW_CONVERSATIONS_DIR || DEFAULT_CONVERSATIONS_DIR;
  fs.mkdirSync(conversationsDir, { recursive: true });

  const entries = fs.readdirSync(conversationsDir);
  const plan = planProviderExchangeArchive({
    ...options,
    timestamp,
    entries,
  });
  if (!plan) return null;
  const filePath = path.join(conversationsDir, plan.relativePath);
  const finalPlan = planProviderExchangeArchive({
    ...options,
    timestamp,
    entries,
    targetExists: fs.existsSync(filePath),
  });
  if (!finalPlan) return null;

  fs.appendFileSync(filePath, finalPlan.content);
  return finalPlan.relativePath;
}

export function planProviderExchangeArchive(
  options: ProviderExchangeArchivePlanInput,
): ProviderExchangeArchivePlan | null {
  const result = options.result?.trim();
  if (!result) return null;

  const filename = threadArchiveFilename(options.entries, options.provider, options.continuation, options.timestamp);

  // Thread-level metadata (provider, thread id) belongs in the header, written
  // once. Per-exchange metadata (timestamp, status) rides in each appended
  // block. Each block leads with a blank line + `---` so the separator renders
  // as a thematic break, not a setext heading underline on the prior line.
  const parts: string[] = [];
  if (!(options.targetExists ?? options.entries.includes(filename))) {
    parts.push(
      `# ${titleCase(options.provider)} Conversation`,
      '',
      `Provider: ${options.provider}`,
      `Continuation/thread id: ${options.continuation || '(none)'}`,
    );
  }
  parts.push(
    '',
    '---',
    '',
    `Archived: ${formatLocalStamp(options.timestamp, TIMEZONE)} · Status: ${options.status}`,
    '',
    `**User**: ${truncate(options.prompt)}`,
    '',
    `**Assistant**: ${truncate(result)}`,
    '',
  );
  return { relativePath: filename, content: parts.join('\n'), write: 'append' };
}

function threadArchiveFilename(
  entries: readonly string[],
  provider: string,
  continuation: string | undefined,
  timestamp: Date,
): string {
  const thread = sanitizeSlug(continuation || 'no-thread').slice(0, 48) || 'no-thread';
  const suffix = `${sanitizeSlug(provider)}-${thread}.md`;
  // Reuse this thread's existing file whatever day it was created; only stamp a
  // new date when none exists. Match on the suffix after the date prefix.
  const dated = /^\d{4}-\d{2}-\d{2}-/;
  const existing = entries.find((file) => dated.test(file) && file.replace(dated, '') === suffix);
  if (existing) return existing;
  // Local calendar day — the agent navigates conversations/ by these
  // date-sortable names, and evening sessions west of UTC would otherwise
  // land under tomorrow's date.
  return `${formatLocalStamp(timestamp, TIMEZONE).slice(0, 10)}-${suffix}`;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : 'Provider';
}

function truncate(value: string): string {
  return value.length > 2000 ? value.slice(0, 2000) + '...' : value;
}
