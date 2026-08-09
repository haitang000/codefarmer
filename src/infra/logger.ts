import { readdir, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pino, { type Logger, type LoggerOptions as PinoLoggerOptions, type StreamEntry } from 'pino';
import type { LogLevel } from '../types.js';
import { getAppPaths } from './paths.js';

export const REDACTED = '[REDACTED]';
const LOG_FILE_PATTERN = /^codefarmer-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|private[-_]?key)/i;
const FILE_BODY_KEY_PATTERN = /^(?:content|file[-_]?content|body|patch|diff)$/i;

export interface CreateLoggerOptions {
  level?: LogLevel;
  logDirectory?: string;
  terminal?: boolean;
  retentionDays?: number;
  now?: Date;
  secrets?: string[];
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED);
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

export function redactLogValue(
  value: unknown,
  secrets: readonly string[] = [],
  seen = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      type: value.name,
      message: redactString(value.message, secrets),
      stack: value.stack ? redactString(value.stack, secrets) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValue(entry, secrets, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) || FILE_BODY_KEY_PATTERN.test(key)
        ? REDACTED
        : redactLogValue(entry, secrets, seen),
    ]),
  );
}

export function dailyLogFile(logDirectory: string, now = new Date()): string {
  return path.join(logDirectory, `codefarmer-${now.toISOString().slice(0, 10)}.jsonl`);
}

export async function cleanupOldLogs(
  logDirectory: string,
  retentionDays = 14,
  now = new Date(),
): Promise<void> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RangeError('retentionDays must be a positive integer');
  }
  await mkdir(logDirectory, { recursive: true });
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1_000;
  const entries = await readdir(logDirectory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const match = LOG_FILE_PATTERN.exec(entry.name);
      if (!match?.[1]) return;
      const timestamp = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (!Number.isNaN(timestamp) && timestamp < cutoff) {
        await rm(path.join(logDirectory, entry.name), { force: true });
      }
    }),
  );
}

export async function createLogger(options: CreateLoggerOptions = {}): Promise<Logger> {
  const level = options.level ?? 'info';
  const streamLevel = level === 'silent' ? 'fatal' : level;
  const logDirectory = options.logDirectory ?? getAppPaths().log;
  const now = options.now ?? new Date();
  await cleanupOldLogs(logDirectory, options.retentionDays ?? 14, now);

  const secrets = [process.env.OPENAI_API_KEY, ...(options.secrets ?? [])].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  const baseOptions: PinoLoggerOptions = {
    level,
    base: { application: 'codefarmer' },
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method) {
        const sanitized = args.map((entry) => redactLogValue(entry, secrets));
        method.apply(this, sanitized as Parameters<typeof method>);
      },
    },
  };

  const streams: StreamEntry[] = [
    {
      level: streamLevel,
      stream: pino.destination({
        dest: dailyLogFile(logDirectory, now),
        mkdir: true,
        sync: true,
      }),
    },
  ];
  if (options.terminal ?? true) {
    streams.push({ level: streamLevel, stream: process.stderr });
  }
  return pino(baseOptions, pino.multistream(streams));
}
