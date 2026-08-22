import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JsonObject, ToolDefinition, ToolResult } from '../types.js';
import { ToolError } from './errors.js';
import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredString,
  successfulResult,
  truncateUtf8,
} from './output.js';
import type { ResolvedToolContext } from './types.js';
import { searchWithRipgrep } from './search-rg.js';
import { isPathInside } from './workspace.js';
import type { WorkspaceGuard } from './workspace.js';

export const listFilesDefinition: ToolDefinition = {
  name: 'list_files',
  description:
    'Recursively list workspace files while ignoring dependencies, build output, and secrets.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: ['string', 'null'], description: 'Workspace-relative directory, or null.' },
      maxDepth: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
      maxResults: { type: ['integer', 'null'], minimum: 1, maximum: 5000 },
    },
    required: ['path', 'maxDepth', 'maxResults'],
    additionalProperties: false,
  },
};

export const readFileDefinition: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file, optionally restricted to an inclusive line range. Each output line is prefixed with its 1-based line number and a `|`; the prefixes are not part of the file.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      startLine: { type: ['integer', 'null'], minimum: 1 },
      endLine: { type: ['integer', 'null'], minimum: 1 },
    },
    required: ['path', 'startLine', 'endLine'],
    additionalProperties: false,
  },
};

export const searchTextDefinition: ToolDefinition = {
  name: 'search_text',
  description:
    'Search UTF-8 workspace files. Matches literal text by default (uses ripgrep when installed), or a JavaScript regular expression when regex is true. Returns path:line:column matches.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      path: {
        type: ['string', 'null'],
        description: 'Workspace-relative file or directory, or null for the whole workspace.',
      },
      glob: { type: ['string', 'null'], description: 'Optional file glob, for example **/*.ts.' },
      caseSensitive: { type: ['boolean', 'null'] },
      maxResults: { type: ['integer', 'null'], minimum: 1, maximum: 500 },
      regex: {
        type: ['boolean', 'null'],
        description: 'When true, treat query as a JavaScript regular expression.',
      },
    },
    required: ['query', 'path', 'glob', 'caseSensitive', 'maxResults', 'regex'],
    additionalProperties: false,
  },
};

interface ListedFile {
  path: string;
  size: number;
}

/**
 * Some gateways stringify a JSON `null` argument into the literal text
 * "null"; treat such values as the workspace root instead of a missing path.
 */
function workspacePathArgument(value: unknown, name: string): string {
  if (value === 'null' || value === 'undefined') return '.';
  return optionalString(value, name, '.') ?? '.';
}

function decodeUtf8(buffer: Buffer, relativePath: string): string {
  try {
    // decode() both validates and converts, so a second pass is unnecessary.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    // Hide the BOM from the model: it is invisible in tool output, and
    // apply_patch matching ignores it, so exposing it only causes context
    // mismatches the model cannot see.
    return text.startsWith('\uFEFF') ? text.slice(1) : text;
  } catch (error) {
    throw new ToolError('INVALID_UTF8', `File is not valid UTF-8 text: ${relativePath}`, {
      cause: error as Error,
    });
  }
}

function fileTooLargeError(relativePath: string, maximumBytes: number, size: number): ToolError {
  return new ToolError(
    'FILE_TOO_LARGE',
    `File exceeds the ${String(maximumBytes)} byte limit: ${relativePath} (${String(size)} bytes)`,
  );
}

async function readTextFile(
  absolutePath: string,
  relativePath: string,
  maximumBytes: number,
  withHash = true,
  knownSize?: number,
): Promise<{ content: string; size: number; sha256: string }> {
  // The search scanner already knows each candidate's size from directory
  // discovery; skipping the stat here saves one syscall per scanned file.
  if (knownSize === undefined) {
    const info = await stat(absolutePath);
    if (info.size > maximumBytes) {
      throw fileTooLargeError(relativePath, maximumBytes, info.size);
    }
  }
  const buffer = await readFile(absolutePath);
  // Guard the read-time size too: a file that grew after discovery (or
  // between stat and read) must not bypass the byte limit.
  if (buffer.byteLength > maximumBytes) {
    throw fileTooLargeError(relativePath, maximumBytes, buffer.byteLength);
  }
  return {
    content: decodeUtf8(buffer, relativePath),
    size: buffer.byteLength,
    sha256: withHash ? createHash('sha256').update(buffer).digest('hex') : '',
  };
}

const COLLECT_DIRECTORY_CONCURRENCY = 12;
const SEARCH_FILE_CONCURRENCY = 12;
const SEARCH_DEADLINE_MS = 15_000;
const MAX_REGEX_SOURCE_CHARS = 200;
const MAX_REGEX_LINE_CHARS = 8_000;
const BINARY_SAMPLE_BYTES = 8_192;
const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.avi',
  '.bin',
  '.bmp',
  '.class',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.flac',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lib',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.o',
  '.obj',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.pyc',
  '.pyo',
  '.rar',
  '.so',
  '.tar',
  '.tgz',
  '.tif',
  '.tiff',
  '.ttf',
  '.wasm',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
]);

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isBinaryExtension(relativePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.byteLength, BINARY_SAMPLE_BYTES)).includes(0);
}

/** Prefix each line with a right-aligned 1-based number and `|`. */
export function formatNumberedLines(lines: string[], startLine: number): string {
  if (lines.length === 0) return '';
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')}|${line}`)
    .join('\n');
}

function compileSearchRegex(source: string, caseSensitive: boolean): RegExp {
  if (source.length > MAX_REGEX_SOURCE_CHARS) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `regex query cannot exceed ${String(MAX_REGEX_SOURCE_CHARS)} characters.`,
    );
  }
  try {
    return new RegExp(source, caseSensitive ? 'gu' : 'giu');
  } catch (error) {
    throw new ToolError('INVALID_ARGUMENT', `Invalid regular expression: ${source}`, {
      cause: error as Error,
    });
  }
}

async function collectFiles(
  guard: WorkspaceGuard,
  startDirectory: string,
  maximumDepth: number,
  maximumResults: number,
): Promise<{ files: ListedFile[]; limitReached: boolean }> {
  const files: ListedFile[] = [];
  const visitedDirectories = new Set<string>();
  let limitReached = false;

  async function visit(directory: string, depth: number): Promise<void> {
    if (files.length >= maximumResults) {
      limitReached = true;
      return;
    }
    const directoryKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
    if (visitedDirectories.has(directoryKey)) return;
    visitedDirectories.add(directoryKey);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirectories: { path: string; depth: number }[] = [];
    for (const entry of entries) {
      if (files.length >= maximumResults) {
        limitReached = true;
        break;
      }
      const lexicalPath = path.join(directory, entry.name);
      const relativePath = guard.toRelative(lexicalPath);
      if (guard.isIgnored(relativePath)) continue;

      let info;
      let resolvedPath = lexicalPath;
      try {
        const lexicalInfo = await lstat(lexicalPath);
        if (lexicalInfo.isSymbolicLink()) {
          resolvedPath = await guard.resolveExisting(relativePath);
          if (!isPathInside(guard.root, resolvedPath)) continue;
          info = await stat(resolvedPath);
        } else {
          info = lexicalInfo;
        }
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        if (depth < maximumDepth) subdirectories.push({ path: resolvedPath, depth: depth + 1 });
      } else if (info.isFile()) {
        files.push({ path: relativePath, size: info.size });
      }
    }

    if (subdirectories.length === 0 || files.length >= maximumResults) return;
    let cursor = 0;
    const workers = Math.min(COLLECT_DIRECTORY_CONCURRENCY, subdirectories.length);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          if (files.length >= maximumResults) {
            limitReached = true;
            return;
          }
          const index = cursor;
          cursor += 1;
          const next = subdirectories[index];
          if (next === undefined) return;
          await visit(next.path, next.depth);
        }
      }),
    );
  }

  await visit(startDirectory, 0);
  if (files.length > maximumResults) {
    files.length = maximumResults;
    limitReached = true;
  }
  // Sibling walks finish out of directory order; sort so list_files and
  // search stay deterministic across hosts and timings.
  files.sort((left, right) => comparePaths(left.path, right.path));
  return { files, limitReached };
}

function globToRegExp(glob: string): RegExp {
  let source = '^';
  const portable = glob.replaceAll('\\', '/');
  for (let index = 0; index < portable.length; index += 1) {
    const character = portable.at(index);
    if (character === undefined) break;
    if (character === '*') {
      if (portable[index + 1] === '*') {
        index += 1;
        if (portable[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u');
}

export async function listFiles(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const requestedPath = workspacePathArgument(arguments_.path, 'path');
  const maxDepth = optionalInteger(arguments_.maxDepth, 'maxDepth', 10, 0, 20);
  const maxResults = optionalInteger(arguments_.maxResults, 'maxResults', 1000, 1, 5000);
  const directory = await guard.resolveExisting(requestedPath, { kind: 'directory' });
  const { files, limitReached } = await collectFiles(guard, directory, maxDepth, maxResults);
  const rendered = files.map((file) => `${file.path}\t${String(file.size)}`).join('\n');
  const truncated = truncateUtf8(rendered, context.maxOutputBytes);
  const data: JsonObject = {
    count: files.length,
    limitReached,
    outputBytes: truncated.originalBytes,
  };
  return successfulResult(callId, 'list_files', truncated.text, {
    data,
    truncated: truncated.truncated || limitReached,
  });
}

export async function readWorkspaceFile(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const relativePath = requiredString(arguments_.path, 'path');
  const absolutePath = await guard.resolveExisting(relativePath, { kind: 'file' });
  const { content, size, sha256 } = await readTextFile(
    absolutePath,
    guard.toRelative(absolutePath),
    context.maxFileBytes,
  );
  const lines = content.split(/\r?\n/u);
  const startLine = optionalInteger(
    arguments_.startLine,
    'startLine',
    1,
    1,
    Math.max(1, lines.length),
  );
  // endLine past the end of the file is clamped rather than rejected: models
  // regularly guess the file length, and the intended range is unambiguous.
  const requestedEnd = optionalInteger(
    arguments_.endLine,
    'endLine',
    lines.length,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const endLine = Math.min(requestedEnd, Math.max(1, lines.length));
  if (endLine < startLine) {
    throw new ToolError('INVALID_ARGUMENT', 'endLine cannot be less than startLine.');
  }
  const selected = formatNumberedLines(lines.slice(startLine - 1, endLine), startLine);
  const truncated = truncateUtf8(selected, context.maxOutputBytes);
  return successfulResult(callId, 'read_file', truncated.text, {
    data: {
      path: guard.toRelative(absolutePath),
      size,
      sha256,
      startLine,
      endLine,
      totalLines: lines.length,
    },
    truncated: truncated.truncated,
  });
}

export async function searchText(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const query = requiredString(arguments_.query, 'query');
  const requestedPath = workspacePathArgument(arguments_.path, 'path');
  const glob = optionalString(arguments_.glob, 'glob');
  const caseSensitive = optionalBoolean(arguments_.caseSensitive, 'caseSensitive', false);
  const maxResults = optionalInteger(arguments_.maxResults, 'maxResults', 100, 1, 500);
  const useRegex = optionalBoolean(arguments_.regex, 'regex', false);
  const matcher = glob === undefined ? undefined : globToRegExp(glob);
  const regex = useRegex ? compileSearchRegex(query, caseSensitive) : undefined;
  // Accept a single file as well as a directory: models frequently point the
  // search at one specific file instead of its parent directory.
  const resolvedPath = await guard.resolveExisting(requestedPath);
  if (regex === undefined) {
    const ripgrepMatches = await searchWithRipgrep({
      query,
      targetRelative: guard.toRelative(resolvedPath),
      caseSensitive,
      ...(glob === undefined ? {} : { glob }),
      maxResults,
      context,
      guard,
      skipPath: isBinaryExtension,
    });
    if (ripgrepMatches !== undefined) {
      const rendered = ripgrepMatches
        .map(
          (match) => `${match.path}:${String(match.line)}:${String(match.column)}: ${match.text}`,
        )
        .join('\n');
      const truncated = truncateUtf8(rendered, context.maxOutputBytes);
      return successfulResult(callId, 'search_text', truncated.text, {
        data: {
          count: ripgrepMatches.length,
          limitReached: ripgrepMatches.length >= maxResults,
          engine: 'rg',
        },
        truncated: truncated.truncated || ripgrepMatches.length >= maxResults,
      });
    }
  }
  const pathInfo = await stat(resolvedPath);
  const files: ListedFile[] = pathInfo.isFile()
    ? [{ path: guard.toRelative(resolvedPath), size: pathInfo.size }]
    : (await collectFiles(guard, resolvedPath, 20, 5000)).files;
  const needle = caseSensitive || regex !== undefined ? query : query.toLowerCase();
  const matches: { path: string; line: number; column: number; text: string }[] = [];
  const deadline = Date.now() + SEARCH_DEADLINE_MS;

  const pushMatch = (filePath: string, line: number, column: number, text: string): boolean => {
    matches.push({ path: filePath, line, column, text: text.trim().slice(0, 500) });
    return matches.length >= maxResults;
  };

  // collectFiles already validated every path inside the workspace, so the
  // scanner only re-checks the final file instead of re-walking parents.
  const scanFile = async (file: ListedFile): Promise<void> => {
    if (matches.length >= maxResults || Date.now() > deadline) return;
    if (isBinaryExtension(file.path)) return;
    try {
      const absolutePath = await guard.resolveExisting(file.path, { kind: 'file' });
      const buffer = await readFile(absolutePath);
      if (buffer.byteLength > context.maxFileBytes || looksBinary(buffer)) return;
      let content: string;
      try {
        content = decodeUtf8(buffer, file.path);
      } catch (error) {
        if (error instanceof ToolError && error.code === 'INVALID_UTF8') return;
        throw error;
      }
      const sourceLines = content.split(/\r?\n/u);
      if (regex !== undefined) {
        // Clone so concurrent file scans cannot share lastIndex.
        const localRegex = new RegExp(regex.source, regex.flags);
        for (let index = 0; index < sourceLines.length; index += 1) {
          const line = sourceLines.at(index);
          if (line === undefined || line.length > MAX_REGEX_LINE_CHARS) continue;
          localRegex.lastIndex = 0;
          let match = localRegex.exec(line);
          while (match !== null) {
            if (pushMatch(file.path, index + 1, match.index + 1, line)) return;
            const consumed = Math.max(1, match[0].length);
            localRegex.lastIndex = match.index + consumed;
            match = localRegex.exec(line);
          }
        }
        return;
      }
      // Lowercasing the whole file once (instead of per line) turns O(lines)
      // allocations into one per file, which adds up when scanning thousands
      // of files; toLowerCase is locale-independent and stays consistent with
      // the lowercased needle above.
      const searchLines = caseSensitive ? sourceLines : content.toLowerCase().split(/\r?\n/u);
      for (let index = 0; index < sourceLines.length; index += 1) {
        const line = sourceLines.at(index);
        if (line === undefined) continue;
        const haystack = caseSensitive ? line : (searchLines.at(index) ?? line);
        let from = 0;
        while (from < haystack.length) {
          const column = haystack.indexOf(needle, from);
          if (column < 0) break;
          if (pushMatch(file.path, index + 1, column + 1, line)) return;
          from = column + Math.max(1, needle.length);
        }
      }
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== 'INVALID_UTF8') throw error;
    }
  };

  const candidates = files.filter(
    (file) =>
      file.size <= context.maxFileBytes &&
      !isBinaryExtension(file.path) &&
      (matcher === undefined || matcher.test(file.path)),
  );

  if (pathInfo.isFile()) {
    const single = candidates[0];
    if (single !== undefined) await scanFile(single);
  } else {
    // Bounded concurrency keeps large workspaces fast without exhausting file
    // handles; results stay roughly in directory order.
    const concurrency = SEARCH_FILE_CONCURRENCY;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          if (matches.length >= maxResults) return;
          const index = cursor;
          cursor += 1;
          const file = candidates[index];
          if (file === undefined) return;
          await scanFile(file);
        }
      }),
    );
  }

  matches.sort((left, right) => {
    const pathOrder = left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    if (pathOrder !== 0) return pathOrder;
    if (left.line !== right.line) return left.line - right.line;
    return left.column - right.column;
  });
  const rendered = matches
    .map((match) => `${match.path}:${String(match.line)}:${String(match.column)}: ${match.text}`)
    .join('\n');
  const truncated = truncateUtf8(rendered, context.maxOutputBytes);
  return successfulResult(callId, 'search_text', truncated.text, {
    data: {
      count: matches.length,
      limitReached: matches.length >= maxResults,
      engine: 'js',
    },
    truncated: truncated.truncated || matches.length >= maxResults,
  });
}
