import path from 'node:path';

import { executeProcess } from './run-command.js';
import type { ResolvedToolContext } from './types.js';
import { isPathInside, type WorkspaceGuard } from './workspace.js';

const DETECT_TIMEOUT_MS = 3_000;
const SEARCH_TIMEOUT_MS = 15_000;

const RG_EXCLUDE_GLOBS = [
  '!**/.git/**',
  '!**/.hg/**',
  '!**/.svn/**',
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
  '!**/__pycache__/**',
  '!**/.venv/**',
  '!**/venv/**',
  '!**/.mypy_cache/**',
  '!**/.pytest_cache/**',
  '!**/.ruff_cache/**',
  '!**/.idea/**',
  '!**/.pnpm-store/**',
  '!**/.tox/**',
  '!**/target/**',
] as const;

export interface RipgrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

let ripgrepAvailable: boolean | undefined;

export function setRipgrepAvailableForTests(value: boolean | undefined): void {
  ripgrepAvailable = value;
}

export async function detectRipgrep(): Promise<boolean> {
  if (ripgrepAvailable !== undefined) return ripgrepAvailable;
  try {
    const result = await executeProcess('rg', ['--version'], {
      cwd: process.cwd(),
      timeoutMs: DETECT_TIMEOUT_MS,
      maximumBufferBytes: 4096,
    });
    ripgrepAvailable = result.exitCode === 0 && !result.timedOut;
  } catch {
    ripgrepAvailable = false;
  }
  return ripgrepAvailable;
}

export function buildRipgrepArgs(options: {
  query: string;
  target: string;
  caseSensitive: boolean;
  glob?: string;
  maxResults: number;
  maxFileBytes: number;
}): string[] {
  const args = [
    '--json',
    '--no-config',
    '--no-messages',
    '--hidden',
    '--follow',
    '-F',
    `--max-filesize=${String(options.maxFileBytes)}`,
    `--max-count=${String(options.maxResults)}`,
  ];
  if (!options.caseSensitive) args.push('-i');
  for (const glob of RG_EXCLUDE_GLOBS) {
    args.push(`--glob=${glob}`);
  }
  if (options.glob !== undefined && options.glob.length > 0) {
    args.push(`--glob=${options.glob}`);
  }
  args.push('--', options.query, options.target);
  return args;
}

interface RipgrepJsonLine {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start?: number }[];
  };
}

export function parseRipgrepJson(stdout: string, maximum: number): RipgrepMatch[] {
  const matches: RipgrepMatch[] = [];
  for (const raw of stdout.split('\n')) {
    if (raw.length === 0 || matches.length >= maximum) break;
    let parsed: RipgrepJsonLine;
    try {
      parsed = JSON.parse(raw) as RipgrepJsonLine;
    } catch {
      continue;
    }
    if (parsed.type !== 'match' || parsed.data === undefined) continue;
    const filePath = parsed.data.path?.text;
    const line = parsed.data.line_number;
    const text = parsed.data.lines?.text?.replace(/\r?\n$/u, '') ?? '';
    if (filePath === undefined || line === undefined) continue;
    const submatches = parsed.data.submatches ?? [];
    if (submatches.length === 0) {
      matches.push({ path: filePath, line, column: 1, text: text.trim().slice(0, 500) });
      continue;
    }
    for (const sub of submatches) {
      if (matches.length >= maximum) break;
      matches.push({
        path: filePath,
        line,
        column: (sub.start ?? 0) + 1,
        text: text.trim().slice(0, 500),
      });
    }
  }
  return matches;
}

export async function searchWithRipgrep(options: {
  query: string;
  targetRelative: string;
  caseSensitive: boolean;
  glob?: string;
  maxResults: number;
  context: ResolvedToolContext;
  guard: WorkspaceGuard;
  skipPath?: (relativePath: string) => boolean;
}): Promise<RipgrepMatch[] | undefined> {
  if (!(await detectRipgrep())) return undefined;
  const target =
    options.targetRelative === '' || options.targetRelative === '.'
      ? '.'
      : options.targetRelative.replaceAll('\\', '/');
  const args = buildRipgrepArgs({
    query: options.query,
    target,
    caseSensitive: options.caseSensitive,
    ...(options.glob === undefined ? {} : { glob: options.glob }),
    maxResults: options.maxResults,
    maxFileBytes: options.context.maxFileBytes,
  });
  let result;
  try {
    result = await executeProcess('rg', args, {
      cwd: options.guard.root,
      timeoutMs: Math.min(SEARCH_TIMEOUT_MS, options.context.commandTimeoutMs),
      maximumBufferBytes: Math.max(options.context.maxOutputBytes * 8, 256 * 1024),
      ...(options.context.signal === undefined ? {} : { signal: options.context.signal }),
    });
  } catch {
    return undefined;
  }
  if (result.timedOut) return undefined;
  // 0 = matches, 1 = no matches; anything else (missing binary, bad pattern) falls back.
  if (result.exitCode !== 0 && result.exitCode !== 1) return undefined;
  const matches: RipgrepMatch[] = [];
  const parsedMatches = parseRipgrepJson(result.stdout, Number.MAX_SAFE_INTEGER);
  // Ripgrep's --follow can report a workspace-relative symlink path whose
  // target is outside the workspace. Validate the resolved target before
  // exposing any matching text to the model. Batch the checks to keep large
  // (but bounded) ripgrep output from creating an unbounded number of fs ops.
  const validationConcurrency = 32;
  const resolvedPaths = new Map<string, Promise<string | undefined>>();
  for (
    let offset = 0;
    offset < parsedMatches.length && matches.length < options.maxResults;
    offset += validationConcurrency
  ) {
    const batch = parsedMatches.slice(offset, offset + validationConcurrency);
    const validated = await Promise.all(
      batch.map(async (match) => {
        const absolute = path.resolve(options.guard.root, match.path);
        if (!isPathInside(options.guard.root, absolute)) return undefined;
        let resolvedPath = resolvedPaths.get(match.path);
        if (resolvedPath === undefined) {
          resolvedPath = options.guard
            .resolveExisting(match.path, { kind: 'file' })
            .catch(() => undefined);
          resolvedPaths.set(match.path, resolvedPath);
        }
        const resolved = await resolvedPath;
        const relative = options.guard.toRelative(absolute);
        if (
          resolved === undefined ||
          !isPathInside(options.guard.root, resolved) ||
          options.guard.isIgnored(relative) ||
          options.skipPath?.(relative) === true
        ) {
          return undefined;
        }
        return { ...match, path: relative };
      }),
    );
    for (const match of validated) {
      if (match === undefined) continue;
      matches.push(match);
      if (matches.length >= options.maxResults) break;
    }
  }
  return matches;
}
