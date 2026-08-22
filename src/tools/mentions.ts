import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { formatNumberedLines } from './file-tools.js';
import { isPathInside, WorkspaceGuard } from './workspace.js';

const MAX_ATTACHED_FILES = 8;
const MAX_ATTACH_CHARS = 12_000;

const MENTION_PATTERN = /(^|[\s([{])@((?:[\w.-]+[\\/])*[\w.-]+\/?)/gu;

export interface PathMention {
  /** Index of the `@` in the source text. */
  start: number;
  /** Exclusive end of the path token. */
  end: number;
  path: string;
}

export interface ExpandedMentions {
  prompt: string;
  attached: string[];
  missing: string[];
}

export function extractPathMentions(text: string): string[] {
  const paths: string[] = [];
  for (const mention of locatePathMentions(text)) {
    if (!paths.includes(mention.path)) paths.push(mention.path);
  }
  return paths;
}

export function locatePathMentions(text: string): PathMention[] {
  MENTION_PATTERN.lastIndex = 0;
  const mentions: PathMention[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const raw = (match[2] ?? '').replaceAll('\\', '/').replace(/[.,:;!?)]+$/u, '');
    if (raw.length === 0 || raw === '.' || raw === '..') continue;
    const at = match.index + (match[1]?.length ?? 0);
    mentions.push({ start: at, end: at + 1 + raw.length, path: raw });
  }
  return mentions;
}

export function mentionAtCursor(value: string, cursor: number): PathMention | undefined {
  const clamped = Math.max(0, Math.min(cursor, value.length));
  return locatePathMentions(value).find(
    (mention) => clamped >= mention.start + 1 && clamped <= mention.end,
  );
}

function longestCommonPrefix(values: string[]): string {
  const first = values[0];
  if (first === undefined) return '';
  let prefix = first;
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    if (prefix.length === 0) return '';
  }
  return prefix;
}

export async function completePathMention(
  prefix: string,
  guard: WorkspaceGuard,
): Promise<string | undefined> {
  const portable = prefix.replaceAll('\\', '/');
  const slash = portable.lastIndexOf('/');
  const directory = slash < 0 ? '.' : portable.slice(0, slash);
  const namePrefix = slash < 0 ? portable : portable.slice(slash + 1);
  let absolute: string;
  try {
    absolute =
      directory === '.' || directory.length === 0
        ? guard.root
        : await guard.resolveExisting(directory, { kind: 'directory' });
  } catch {
    return undefined;
  }
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(namePrefix.toLowerCase())) continue;
    const relative = guard.toRelative(path.join(absolute, entry.name));
    if (guard.isIgnored(relative)) continue;
    matches.push(
      entry.isDirectory() ? `${relative.replaceAll('\\', '/')}/` : relative.replaceAll('\\', '/'),
    );
  }
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  const common = longestCommonPrefix(matches);
  return common.length > prefix.length ? common : undefined;
}

export async function expandPathMentions(
  prompt: string,
  options: { workspace: string; ignoredPaths: string[]; maxFileBytes: number },
): Promise<ExpandedMentions> {
  const mentions = extractPathMentions(prompt).slice(0, MAX_ATTACHED_FILES);
  if (mentions.length === 0) return { prompt, attached: [], missing: [] };

  const guard = await WorkspaceGuard.create(options.workspace, options.ignoredPaths);
  const attached: string[] = [];
  const missing: string[] = [];
  const blocks: string[] = [];

  for (const relative of mentions) {
    try {
      const absolute = await guard.resolveExisting(relative);
      if (!isPathInside(guard.root, absolute)) {
        missing.push(relative);
        continue;
      }
      const info = await stat(absolute);
      if (info.isDirectory()) {
        const listing = await readdir(absolute, { withFileTypes: true });
        const names = listing
          .map((entry) => {
            const child = guard.toRelative(path.join(absolute, entry.name));
            if (guard.isIgnored(child)) return undefined;
            return entry.isDirectory() ? `${entry.name}/` : entry.name;
          })
          .filter((name): name is string => name !== undefined)
          .slice(0, 80);
        blocks.push(`### ${relative.replaceAll('\\', '/')} (directory)\n${names.join('\n')}`);
        attached.push(relative);
        continue;
      }
      if (!info.isFile() || info.size > options.maxFileBytes) {
        missing.push(relative);
        continue;
      }
      const buffer = await readFile(absolute);
      if (buffer.byteLength > options.maxFileBytes) {
        missing.push(relative);
        continue;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      const content = text.startsWith('\uFEFF') ? text.slice(1) : text;
      const lines = content.split(/\r?\n/u);
      let numbered = formatNumberedLines(lines, 1);
      if (numbered.length > MAX_ATTACH_CHARS) {
        numbered = `${numbered.slice(0, MAX_ATTACH_CHARS)}\n…[attached file truncated]`;
      }
      blocks.push(`### ${guard.toRelative(absolute)}\n${numbered}`);
      attached.push(relative);
    } catch {
      missing.push(relative);
    }
  }

  if (blocks.length === 0) {
    return { prompt, attached, missing };
  }

  const appendix = [
    '',
    '<attached_files>',
    'The user referenced these workspace files with @path. Line-number prefixes are metadata, not file content.',
    ...blocks,
    ...(missing.length === 0 ? [] : [`Missing or unreadable: ${missing.join(', ')}`]),
    '</attached_files>',
  ].join('\n');

  return { prompt: `${prompt}${appendix}`, attached, missing };
}
