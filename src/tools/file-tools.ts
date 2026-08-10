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
  description: 'Read a UTF-8 text file, optionally restricted to an inclusive line range.',
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
  description: 'Safely search for literal text in UTF-8 workspace files.',
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
    },
    required: ['query', 'path', 'glob', 'caseSensitive', 'maxResults'],
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

    const entries = await readdir(directory, { withFileTypes: true });
    // Plain code-unit comparison: faster than localeCompare and stable across
    // host locales, which keeps directory listing deterministic everywhere.
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= maximumResults) {
        limitReached = true;
        return;
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
        if (depth < maximumDepth) await visit(resolvedPath, depth + 1);
      } else if (info.isFile()) {
        files.push({ path: relativePath, size: info.size });
      }
    }
  }

  await visit(startDirectory, 0);
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
  const selected = lines.slice(startLine - 1, endLine).join('\n');
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
  const matcher = glob === undefined ? undefined : globToRegExp(glob);
  // Accept a single file as well as a directory: models frequently point the
  // search at one specific file instead of its parent directory.
  const resolvedPath = await guard.resolveExisting(requestedPath);
  const pathInfo = await stat(resolvedPath);
  const files: ListedFile[] = pathInfo.isFile()
    ? [{ path: guard.toRelative(resolvedPath), size: pathInfo.size }]
    : (await collectFiles(guard, resolvedPath, 20, 5000)).files;
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: { path: string; line: number; column: number; text: string }[] = [];

  // collectFiles already validated every path inside the workspace, so the
  // scanner only re-checks the final file instead of re-walking parents.
  const scanFile = async (file: ListedFile): Promise<void> => {
    if (matches.length >= maxResults) return;
    try {
      const absolutePath = await guard.resolveExisting(file.path, { kind: 'file' });
      const { content } = await readTextFile(
        absolutePath,
        file.path,
        context.maxFileBytes,
        false,
        file.size,
      );
      // Lowercasing the whole file once (instead of per line) turns O(lines)
      // allocations into one per file, which adds up when scanning thousands
      // of files; toLowerCase is locale-independent and stays consistent with
      // the lowercased needle above.
      const sourceLines = content.split(/\r?\n/u);
      const searchLines =
        caseSensitive ? sourceLines : content.toLowerCase().split(/\r?\n/u);
      for (let index = 0; index < sourceLines.length; index += 1) {
        const line = sourceLines.at(index);
        if (line === undefined) continue;
        const haystack = caseSensitive ? line : (searchLines.at(index) ?? line);
        const column = haystack.indexOf(needle);
        if (column >= 0) {
          matches.push({
            path: file.path,
            line: index + 1,
            column: column + 1,
            text: line.trim().slice(0, 500),
          });
          if (matches.length >= maxResults) return;
        }
      }
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== 'INVALID_UTF8') throw error;
    }
  };

  const candidates = files.filter(
    (file) =>
      file.size <= context.maxFileBytes && (matcher === undefined || matcher.test(file.path)),
  );

  if (pathInfo.isFile()) {
    const single = candidates[0];
    if (single !== undefined) await scanFile(single);
  } else {
    // Bounded concurrency keeps large workspaces fast without exhausting file
    // handles; results stay roughly in directory order.
    const concurrency = 8;
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

  const rendered = matches
    .map((match) => `${match.path}:${String(match.line)}:${String(match.column)}: ${match.text}`)
    .join('\n');
  const truncated = truncateUtf8(rendered, context.maxOutputBytes);
  return successfulResult(callId, 'search_text', truncated.text, {
    data: { count: matches.length, limitReached: matches.length >= maxResults },
    truncated: truncated.truncated || matches.length >= maxResults,
  });
}
