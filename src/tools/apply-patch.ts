import { createHash, randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  JsonObject,
  MutationOperation,
  MutationTransaction,
  ToolDefinition,
  ToolResult,
} from '../types.js';
import { ToolError } from './errors.js';
import { requiredString, successfulResult } from './output.js';
import type { ResolvedToolContext } from './types.js';
import { isPathInside } from './workspace.js';
import type { WorkspaceGuard } from './workspace.js';

export const applyPatchDefinition: ToolDefinition = {
  name: 'apply_patch',
  description:
    'Apply a unified diff to one UTF-8 file. Pass its SHA-256, or null when creating it.',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      patch: {
        type: 'string',
        description:
          'A unified diff containing only this file. Context lines must match the current file content; @@ line numbers and line counts are corrected automatically, so approximate values are fine.',
      },
      expectedSha256: {
        type: ['string', 'null'],
        description: 'SHA-256 of the existing file, or null when creating it.',
      },
    },
    required: ['path', 'patch', 'expectedSha256'],
    additionalProperties: false,
  },
};

interface ParsedHeader {
  oldPath: string | null;
  newPath: string | null;
  hunksStart: number;
}

interface AppliedDiff {
  content: string;
  operation: MutationOperation;
  addedLines: number;
  removedLines: number;
}

interface HunkLine {
  kind: ' ' | '+' | '-';
  value: string;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
  lines: HunkLine[];
  noNewlineAfterOld: boolean;
  noNewlineAfterNew: boolean;
  /** The @@ header carried no usable line number; search the whole file. */
  positionUnknown: boolean;
}

const HUNK_HEADER_STRICT = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

interface HunkHeaderInfo {
  oldStart: number;
  oldCount: number;
  newCount: number;
  positionUnknown: boolean;
}

/**
 * Maximum distance a hunk may drift from its declared line number before we
 * give up. Models frequently emit stale line numbers; recovering with a nearby
 * exact match keeps long agent runs alive instead of failing the whole task.
 */
const FUZZ_SEARCH_RADIUS = 500;

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function sha256FileContent(content: Buffer | string): string {
  return sha256(content);
}

/**
 * Render a changed-line tally for human-facing output, e.g. ` (+3 -2)`.
 * Zero sides are omitted so creations read `(+12)` and deletions `(-9)`.
 */
export function formatLineStats(addedLines: number, removedLines: number): string {
  const parts: string[] = [];
  if (addedLines > 0) parts.push(`+${String(addedLines)}`);
  if (removedLines > 0) parts.push(`-${String(removedLines)}`);
  return parts.length === 0 ? '' : ` (${parts.join(' ')})`;
}

/**
 * Cheap line-change tally for whole-file rewrites: trim the shared prefix and
 * suffix, then count the differing middle on each side. Exact for the typical
 * localized edit; a good-enough estimate when most of the file changes.
 */
export function countLineChanges(before: string, after: string): { added: number; removed: number } {
  // A trailing newline terminates the last line; without trimming it, every
  // file gains a phantom empty last line and creations count one too many.
  const toLines = (value: string): string[] => {
    const body = value.endsWith('\n') ? value.slice(0, -1) : value;
    return body.length === 0 ? [] : body.split('\n');
  };
  const oldLines = toLines(before);
  const newLines = toLines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { added: newEnd - start, removed: oldEnd - start };
}

/**
 * Render a string in an error message so that characters which are invisible
 * in a terminal (BOM, zero-width spaces, non-breaking spaces) show up as
 * escapes; JSON.stringify alone passes them through raw.
 */
function showInvisible(value: string): string {
  return JSON.stringify(
    value
      .replaceAll('\uFEFF', '\\uFEFF')
      .replaceAll('\u200B', '\\u200B')
      .replaceAll('\u00A0', '\\u00A0'),
  );
}

function decodeUtf8(buffer: Buffer, relativePath: string): string {
  try {
    // decode() both validates and converts, so a second pass is unnecessary.
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new ToolError('INVALID_UTF8', `File is not valid UTF-8 text: ${relativePath}`, {
      cause: error as Error,
    });
  }
}

function cleanHeaderPath(value: string): string | null {
  const withoutTimestamp = (value.split('\t', 1).at(0) ?? '').trim();
  if (withoutTimestamp === '/dev/null') return null;
  const unquoted =
    withoutTimestamp.startsWith('"') && withoutTimestamp.endsWith('"')
      ? withoutTimestamp.slice(1, -1)
      : withoutTimestamp;
  const portable = unquoted.replaceAll('\\', '/');
  return portable.startsWith('a/') || portable.startsWith('b/') ? portable.slice(2) : portable;
}

function normaliseRequestedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function hasFileHeaders(lines: string[]): boolean {
  return lines.some(
    (line, index) => line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ '),
  );
}

/**
 * Weak models sometimes drop the ---/+++ file headers and send only the @@
 * hunks. The target path is a tool argument, so the headers can be rebuilt:
 * an existing file is modified, a missing one is created. Returns null when
 * the patch has no @@ hunk header to anchor the insertion.
 */
function synthesizeFileHeaders(
  lines: string[],
  requestedPath: string,
  fileExists: boolean,
): string[] | null {
  const hunkIndex = lines.findIndex((line) => line.startsWith('@@'));
  if (hunkIndex < 0) return null;
  const target = normaliseRequestedPath(requestedPath);
  const headers = fileExists
    ? [`--- a/${target}`, `+++ b/${target}`]
    : ['--- /dev/null', `+++ b/${target}`];
  return [...lines.slice(0, hunkIndex), ...headers, ...lines.slice(hunkIndex)];
}

function parseHeader(lines: string[], requestedPath: string): ParsedHeader {
  let headerIndex = -1;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const oldHeader = lines.at(index);
    const newHeader = lines.at(index + 1);
    if (oldHeader?.startsWith('--- ') === true && newHeader?.startsWith('+++ ') === true) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) {
    throw new ToolError('PATCH_INVALID', 'Patch is missing the ---/+++ file headers.');
  }

  const oldHeader = lines.at(headerIndex);
  const newHeader = lines.at(headerIndex + 1);
  if (oldHeader === undefined || newHeader === undefined) {
    throw new ToolError('PATCH_INVALID', 'Patch file headers are incomplete.');
  }
  const oldPath = cleanHeaderPath(oldHeader.slice(4));
  const newPath = cleanHeaderPath(newHeader.slice(4));
  if (oldPath === null && newPath === null) {
    throw new ToolError('PATCH_INVALID', 'Both patch paths cannot be /dev/null.');
  }
  const expected = normaliseRequestedPath(requestedPath);
  for (const headerPath of [oldPath, newPath]) {
    if (headerPath !== null && normaliseRequestedPath(headerPath) !== expected) {
      throw new ToolError(
        'PATCH_INVALID',
        `Patch header does not match path: ${headerPath} != ${expected}`,
      );
    }
  }
  return { oldPath, newPath, hunksStart: headerIndex + 2 };
}

function splitSource(content: string): { lines: string[]; trailingNewline: boolean; eol: string } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  // A UTF-8 BOM survives TextDecoder and is invisible in read_file output,
  // so matching must ignore it or every first-line context line mismatches.
  const normalised = content.replaceAll('\r\n', '\n').replace(/^\uFEFF/u, '');
  const trailingNewline = normalised.endsWith('\n');
  const lines = normalised.split('\n');
  if (trailingNewline) lines.pop();
  if (lines.length === 1 && lines[0] === '' && content.length === 0) lines.pop();
  return { lines, trailingNewline, eol };
}

/**
 * Decide whether a blank line belongs to the hunk body once the declared
 * counts are exhausted: skip ahead past further blanks and check whether the
 * next real line still carries a hunk prefix. Trailing separator blanks are
 * followed by a boundary (@@ header, file header, or end of patch) and end
 * the hunk instead.
 */
function hunkContinuesAfterBlank(lines: string[], position: number): boolean {
  let cursor = position + 1;
  while (cursor < lines.length && lines[cursor] === '') cursor += 1;
  const next = lines.at(cursor);
  if (next === undefined) return false;
  if (next.startsWith('@@')) return false;
  if (next.startsWith('--- ') && lines[cursor + 1]?.startsWith('+++ ')) return false;
  const marker = next[0];
  return marker === ' ' || marker === '+' || marker === '-';
}

/**
 * Parse the body of a hunk into structured lines. Tolerates the mistakes
 * weaker models make: blank context lines that lost their leading space,
 * context lines emitted without any prefix at all, and @@ headers whose
 * declared line counts do not match the body. Counts are treated as advisory
 * (git apply --recount style): once the declared counts are satisfied, lines
 * with an explicit ' ', '+', or '-' prefix are still consumed, and a hunk that
 * ends early at the next boundary is accepted with its actual counts.
 */
function parseHunkLines(
  lines: string[],
  index: number,
  oldCount: number,
  newCount: number,
): { hunkLines: HunkLine[]; nextIndex: number; noNewlineAfterOld: boolean; noNewlineAfterNew: boolean } {
  const hunkLines: HunkLine[] = [];
  let consumedOld = 0;
  let producedNew = 0;
  let noNewlineAfterOld = false;
  let noNewlineAfterNew = false;
  let position = index;
  let previousKind: ' ' | '+' | '-' | undefined;

  while (position < lines.length) {
    const patchLine = lines.at(position);
    if (patchLine === undefined) break;
    if (patchLine.startsWith('@@') || (patchLine.startsWith('--- ') && lines[position + 1]?.startsWith('+++ '))) {
      break;
    }
    if (patchLine === '\\ No newline at end of file') {
      if (previousKind === undefined) {
        throw new ToolError('PATCH_INVALID', 'No-newline marker has no preceding content line.');
      }
      if (previousKind === ' ' || previousKind === '+') noNewlineAfterNew = true;
      if (previousKind === ' ' || previousKind === '-') noNewlineAfterOld = true;
      position += 1;
      continue;
    }
    if (consumedOld === oldCount && producedNew === newCount) {
      // Declared counts are only advisory: weak models routinely under-count
      // the lines they emit. Keep consuming while the line carries an
      // explicit hunk prefix. Blank lines carry no prefix at all, so they are
      // kept only when the hunk plainly continues afterwards; anything else
      // ends the hunk.
      const marker = patchLine[0];
      const explicit = marker === ' ' || marker === '+' || marker === '-';
      if (!explicit && (patchLine !== '' || !hunkContinuesAfterBlank(lines, position))) break;
    }
    const first = patchLine[0] as ' ' | '+' | '-' | undefined;
    let kind: ' ' | '+' | '-';
    let value: string;
    if (first === ' ' || first === '+' || first === '-') {
      kind = first;
      value = patchLine.slice(1);
    } else if (consumedOld < oldCount) {
      // A context line whose leading space was dropped; blank lines lose it
      // most often, but bare text loses it too.
      kind = ' ';
      value = patchLine;
    } else if (producedNew < newCount) {
      // The old side is satisfied but the new side is not: an addition whose
      // '+' prefix was dropped. This is the only possibility for blank lines
      // inside file-creation hunks, which have no old side at all.
      kind = '+';
      value = patchLine;
    } else if (patchLine === '' && hunkContinuesAfterBlank(lines, position)) {
      // Counts are exhausted yet the hunk continues past this blank line:
      // keep it as an empty context line, or an empty addition for
      // file-creation hunks (which have no old side).
      kind = oldCount === 0 ? '+' : ' ';
      value = '';
    } else {
      throw new ToolError(
        'PATCH_INVALID',
        `Invalid line in patch hunk: ${JSON.stringify(patchLine)}. Every hunk line must start with ' ', '+', or '-'. Regenerate the complete unified diff.`,
      );
    }
    if (kind === ' ' || kind === '-') consumedOld += 1;
    if (kind === ' ' || kind === '+') producedNew += 1;
    hunkLines.push({ kind, value });
    previousKind = kind;
    position += 1;
  }

  // A hunk that ends before its declared counts are satisfied is accepted
  // with the counts it actually has; application re-derives them from the
  // parsed lines, so a stale @@ header cannot corrupt the result.
  return { hunkLines, nextIndex: position, noNewlineAfterOld, noNewlineAfterNew };
}

/**
 * Count the hunk body up to the next boundary and use those totals as
 * advisory counts when the @@ header omits them. Blank and unprefixed lines
 * are assumed to be context, matching how parseHunkLines classifies them.
 */
function estimateHunkCounts(
  lines: string[],
  start: number,
): { oldCount: number; newCount: number } {
  const body: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines.at(index);
    if (line === undefined) break;
    if (
      line.startsWith('@@') ||
      (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ '))
    ) {
      break;
    }
    body.push(line);
  }
  // Trailing separator blanks are not content.
  while (body.length > 0 && body.at(-1) === '') body.pop();
  let oldCount = 0;
  let newCount = 0;
  for (const line of body) {
    if (line === '\\ No newline at end of file') continue;
    const marker = line[0];
    if (marker === '+') newCount += 1;
    else if (marker === '-') oldCount += 1;
    else {
      oldCount += 1;
      newCount += 1;
    }
  }
  return { oldCount, newCount };
}

/**
 * Parse an @@ hunk header. The strict format comes first, then a tolerant
 * pass salvages whatever numbers are present: models emit bare "@@",
 * headers without counts, or drop the closing "@@". A missing position marks
 * the hunk for a whole-file search; missing counts fall back to a body
 * estimate. Returns null when the line is not a hunk header at all.
 */
function parseHunkHeader(line: string, lines: string[], bodyStart: number): HunkHeaderInfo | null {
  if (!line.startsWith('@@')) return null;
  const strict = HUNK_HEADER_STRICT.exec(line);
  if (strict !== null) {
    return {
      oldStart: Number(strict[1] ?? '0'),
      oldCount: strict[2] === undefined ? 1 : Number(strict[2]),
      newCount: strict[4] === undefined ? 1 : Number(strict[4]),
      positionUnknown: false,
    };
  }
  const closing = line.indexOf('@@', 2);
  const ranges = closing >= 0 ? line.slice(2, closing) : line.slice(2);
  const oldRange = /-(\d+)(?:\s*,\s*(\d+))?/u.exec(ranges);
  const newRange = /\+(\d+)(?:\s*,\s*(\d+))?/u.exec(ranges);
  const estimated =
    oldRange?.[2] !== undefined && newRange?.[2] !== undefined
      ? undefined
      : estimateHunkCounts(lines, bodyStart);
  return {
    oldStart: oldRange === null ? 0 : Number(oldRange[1]),
    oldCount: oldRange?.[2] === undefined ? (estimated?.oldCount ?? 1) : Number(oldRange[2]),
    newCount: newRange?.[2] === undefined ? (estimated?.newCount ?? 1) : Number(newRange[2]),
    positionUnknown: oldRange === null,
  };
}

function parseHunks(lines: string[], startIndex: number): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const current = lines.at(index);
    if (current === undefined) break;
    if (current === '') {
      index += 1;
      continue;
    }
    if (current.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
      throw new ToolError('PATCH_INVALID', 'apply_patch can modify only one file at a time.');
    }
    const headerInfo = parseHunkHeader(current, lines, index + 1);
    if (headerInfo === null) {
      throw new ToolError(
        'PATCH_INVALID',
        `Cannot parse patch line: ${JSON.stringify(current)}. The patch must be a complete unified diff with ---/+++ headers and @@ hunk headers; do not include prose, commands, or partial snippets. Regenerate the full diff.`,
      );
    }
    const parsed = parseHunkLines(lines, index + 1, headerInfo.oldCount, headerInfo.newCount);
    hunks.push({
      oldStart: headerInfo.oldStart,
      // The declared counts are advisory; store the real ones.
      oldCount: parsed.hunkLines.filter((line) => line.kind !== '+').length,
      newCount: parsed.hunkLines.filter((line) => line.kind !== '-').length,
      lines: parsed.hunkLines,
      noNewlineAfterOld: parsed.noNewlineAfterOld,
      noNewlineAfterNew: parsed.noNewlineAfterNew,
      positionUnknown: headerInfo.positionUnknown,
    });
    index = parsed.nextIndex;
  }

  if (hunks.length === 0) throw new ToolError('PATCH_INVALID', 'Patch contains no hunks.');
  return hunks;
}

function matchesAt(
  sourceLines: string[],
  candidate: number,
  oldLines: string[],
  ignoreTrailingWhitespace: boolean,
): boolean {
  if (candidate < 0 || candidate + oldLines.length > sourceLines.length) return false;
  for (let offset = 0; offset < oldLines.length; offset += 1) {
    const expected = oldLines.at(offset) ?? '';
    const actual = sourceLines.at(candidate + offset) ?? '';
    if (ignoreTrailingWhitespace) {
      if (actual.replace(/[ \t]+$/u, '') !== expected.replace(/[ \t]+$/u, '')) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Locate the source position a hunk applies to. Tries the declared line
 * number first, then searches nearby offsets, finally relaxing trailing
 * whitespace. Returns -1 when nothing matches.
 */
function locateHunk(sourceLines: string[], hunk: ParsedHunk): { position: number; fuzzy: boolean } {
  const oldLines = hunk.lines.filter((line) => line.kind !== '+').map((line) => line.value);
  const declared = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
  if (oldLines.length === 0) {
    const clamped = Math.min(Math.max(declared, 0), sourceLines.length);
    return { position: clamped, fuzzy: false };
  }
  if (matchesAt(sourceLines, declared, oldLines, false)) return { position: declared, fuzzy: false };
  // A hunk without any line number in its @@ header has no anchor; fall back
  // to searching the whole file instead of only the drift radius.
  const limit = hunk.positionUnknown
    ? sourceLines.length
    : Math.min(FUZZ_SEARCH_RADIUS, sourceLines.length);
  for (let distance = 1; distance <= limit; distance += 1) {
    for (const sign of [1, -1]) {
      const candidate = declared + sign * distance;
      if (matchesAt(sourceLines, candidate, oldLines, false)) return { position: candidate, fuzzy: true };
    }
  }
  if (matchesAt(sourceLines, declared, oldLines, true)) return { position: declared, fuzzy: true };
  for (let distance = 1; distance <= limit; distance += 1) {
    for (const sign of [1, -1]) {
      const candidate = declared + sign * distance;
      if (matchesAt(sourceLines, candidate, oldLines, true)) return { position: candidate, fuzzy: true };
    }
  }
  return { position: -1, fuzzy: false };
}

function applyHunks(
  sourceContent: string,
  lines: string[],
  startIndex: number,
  forceLf: boolean,
): { content: string; addedLines: number; removedLines: number } {
  const source = splitSource(sourceContent);
  const hunks = parseHunks(lines, startIndex);
  const output: string[] = [];
  let sourceCursor = 0;
  let newNoNewline = false;
  let finalHunkTouchesEof = false;
  let addedLines = 0;
  let removedLines = 0;

  for (const hunk of hunks) {
    const located = locateHunk(source.lines, hunk);
    if (located.position < 0) {
      const firstOld = hunk.lines.find((line) => line.kind !== '+')?.value ?? '';
      throw new ToolError(
        'PATCH_CONFLICT',
        `Patch context does not match near line ${String(hunk.oldStart)}: expected ${showInvisible(firstOld)}, found ${showInvisible(source.lines[hunk.oldStart - 1] ?? '<end of file>')}. Re-read the file and regenerate the patch against its current content.`,
      );
    }
    if (located.position < sourceCursor) {
      throw new ToolError(
        'PATCH_CONFLICT',
        `Patch hunks overlap: hunk at line ${String(hunk.oldStart)} resolves before the previous hunk. Regenerate the patch with correct line numbers.`,
      );
    }
    output.push(...source.lines.slice(sourceCursor, located.position));
    for (const line of hunk.lines) {
      if (line.kind === '+') {
        addedLines += 1;
        output.push(line.value);
      } else if (line.kind === ' ') {
        // Keep the file's own text for context so fuzzy whitespace matches
        // never silently rewrite existing content.
        output.push(source.lines[located.position] ?? line.value);
        located.position += 1;
      } else {
        removedLines += 1;
        located.position += 1;
      }
    }
    sourceCursor = located.position;
    if (hunk.noNewlineAfterNew) newNoNewline = true;
    finalHunkTouchesEof = sourceCursor === source.lines.length;
  }

  output.push(...source.lines.slice(sourceCursor));
  const trailingNewline = newNoNewline
    ? false
    : finalHunkTouchesEof
      ? true
      : source.trailingNewline;
  const eol = forceLf ? '\n' : source.eol;
  const content =
    output.length === 0
      ? ''
      : `${output.join(eol)}${trailingNewline ? eol : ''}`;
  return { content, addedLines, removedLines };
}

export function applyUnifiedDiff(
  sourceContent: string,
  patch: string,
  requestedPath: string,
  fileExists: boolean,
): AppliedDiff {
  if (patch.includes('\0')) throw new ToolError('PATCH_INVALID', 'Patch cannot contain NUL bytes.');
  let lines = patch.replaceAll('\r\n', '\n').split('\n');
  if (!hasFileHeaders(lines)) {
    const synthesised = synthesizeFileHeaders(lines, requestedPath, fileExists);
    if (synthesised !== null) lines = synthesised;
  }
  const header = parseHeader(lines, requestedPath);
  const operation: MutationOperation =
    header.oldPath === null ? 'create' : header.newPath === null ? 'delete' : 'modify';
  if (operation === 'create' && fileExists) {
    throw new ToolError('PATCH_CONFLICT', `Create patch target already exists: ${requestedPath}`);
  }
  if (operation !== 'create' && !fileExists) {
    throw new ToolError('PATCH_CONFLICT', `Patch target does not exist: ${requestedPath}`);
  }
  const applied = applyHunks(sourceContent, lines, header.hunksStart, operation === 'create');
  if (operation === 'delete' && applied.content !== '') {
    throw new ToolError('PATCH_INVALID', 'Delete patch leaves content in the file.');
  }
  return {
    content: applied.content,
    operation,
    addedLines: applied.addedLines,
    removedLines: applied.removedLines,
  };
}

export async function atomicWrite(target: string, content: Buffer, mode?: number): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.codefarmer-${String(process.pid)}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    if (mode !== undefined) await chmod(target, mode);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function expectedHash(arguments_: Record<string, unknown>): string | null {
  const value = arguments_.expectedSha256;
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(value)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'expectedSha256 must be a 64-character hexadecimal SHA-256, or null for creation.',
    );
  }
  return value.toLowerCase();
}

export async function applyPatch(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const requestedPath = requiredString(arguments_.path, 'path');
  const patch = requiredString(arguments_.patch, 'patch');
  const expected = expectedHash(arguments_);
  const resolved = await guard.resolveForWrite(requestedPath);
  let beforeBuffer = Buffer.alloc(0);
  let mode: number | undefined;
  if (resolved.exists) {
    const info = await stat(resolved.path);
    if (info.size > context.maxFileBytes) {
      throw new ToolError(
        'FILE_TOO_LARGE',
        `File exceeds the ${String(context.maxFileBytes)} byte limit.`,
      );
    }
    beforeBuffer = await readFile(resolved.path);
    mode = info.mode;
  }
  const beforeHash = resolved.exists ? sha256(beforeBuffer) : null;
  if (expected !== beforeHash) {
    throw new ToolError(
      'PATCH_CONFLICT',
      `File baseline changed (expected ${expected ?? 'missing'}, got ${beforeHash ?? 'missing'}). The file changed since it was last read; call read_file again to obtain the current content and SHA-256, then regenerate the patch.`,
    );
  }
  const beforeContent = decodeUtf8(beforeBuffer, requestedPath);
  const applied = applyUnifiedDiff(beforeContent, patch, requestedPath, resolved.exists);
  const afterBuffer = Buffer.from(applied.content, 'utf8');
  if (afterBuffer.byteLength > context.maxFileBytes) {
    throw new ToolError(
      'FILE_TOO_LARGE',
      `Patch result exceeds the ${String(context.maxFileBytes)} byte limit.`,
    );
  }
  if (context.approve !== undefined) {
    const approved = await context.approve({
      kind: 'file-mutation',
      title: `${applied.operation}: ${normaliseRequestedPath(requestedPath)}`,
      detail: patch,
      readOnly: false,
    });
    if (!approved)
      throw new ToolError('APPROVAL_DENIED', 'The file change was rejected by the user.');
  }

  const targetPath =
    resolved.exists || applied.operation === 'delete'
      ? resolved.path
      : await guard.prepareParentForWrite(resolved.path);
  if (applied.operation === 'delete') await unlink(targetPath);
  else await atomicWrite(targetPath, afterBuffer, mode);

  const relativePath = normaliseRequestedPath(requestedPath);
  const transaction: MutationTransaction = {
    version: 1,
    id: randomUUID(),
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    workspace: guard.root,
    path: relativePath,
    operation: applied.operation,
    beforeHash,
    afterHash: applied.operation === 'delete' ? null : sha256(afterBuffer),
    beforeContent: resolved.exists ? beforeContent : null,
    ...(mode === undefined ? {} : { beforeMode: mode }),
    afterContent: applied.operation === 'delete' ? null : applied.content,
    diff: patch,
    createdAt: new Date().toISOString(),
  };
  try {
    await context.onMutation?.(transaction);
  } catch (error) {
    try {
      if (!resolved.exists) await unlink(targetPath);
      else await atomicWrite(targetPath, beforeBuffer, mode);
    } catch (rollbackError) {
      throw new ToolError(
        'TRANSACTION_FAILED',
        `Mutation audit failed and rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error as Error },
      );
    }
    throw new ToolError(
      'TRANSACTION_FAILED',
      'Mutation audit failed; the file change was rolled back.',
      {
        cause: error as Error,
      },
    );
  }
  const data: JsonObject = {
    transactionId: transaction.id,
    path: transaction.path,
    operation: transaction.operation,
    beforeHash: transaction.beforeHash,
    afterHash: transaction.afterHash,
    addedLines: applied.addedLines,
    removedLines: applied.removedLines,
  };
  return successfulResult(
    callId,
    'apply_patch',
    `${applied.operation}: ${relativePath}${formatLineStats(applied.addedLines, applied.removedLines)}`,
    {
      data,
    },
  );
}

export async function restoreMutation(
  transaction: MutationTransaction,
  guard: WorkspaceGuard,
  maximumFileBytes = 1024 * 1024,
): Promise<MutationTransaction> {
  if (
    !isPathInside(guard.root, transaction.workspace) ||
    !isPathInside(transaction.workspace, guard.root)
  ) {
    throw new ToolError('PATH_OUTSIDE_WORKSPACE', 'Mutation belongs to a different workspace.');
  }
  const resolved = await guard.resolveForWrite(transaction.path);
  const currentBuffer = resolved.exists ? await readFile(resolved.path) : null;
  const currentHash = currentBuffer === null ? null : sha256(currentBuffer);
  if (currentHash !== transaction.afterHash) {
    throw new ToolError(
      'PATCH_CONFLICT',
      `File changed after the mutation; refusing to overwrite it: ${transaction.path}`,
    );
  }

  if (transaction.beforeContent === null) {
    if (resolved.exists) await unlink(resolved.path);
  } else {
    const beforeBuffer = Buffer.from(transaction.beforeContent, 'utf8');
    if (beforeBuffer.byteLength > maximumFileBytes) {
      throw new ToolError('FILE_TOO_LARGE', 'Undo snapshot exceeds the file size limit.');
    }
    if (sha256(beforeBuffer) !== transaction.beforeHash) {
      throw new ToolError('PATCH_CONFLICT', 'Undo snapshot hash validation failed.');
    }
    const currentMode = resolved.exists ? (await stat(resolved.path)).mode : undefined;
    const restoreMode = transaction.beforeMode ?? currentMode;
    const targetPath = resolved.exists
      ? resolved.path
      : await guard.prepareParentForWrite(resolved.path);
    await atomicWrite(targetPath, beforeBuffer, restoreMode);
  }
  return { ...transaction, undoneAt: new Date().toISOString() };
}
