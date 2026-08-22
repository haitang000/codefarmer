export const MAX_COMPOSER_LINES = 8;

export function insertAtCursor(
  value: string,
  cursor: number,
  inserted: string,
): { value: string; cursor: number } {
  const clamped = Math.max(0, Math.min(cursor, value.length));
  return {
    value: `${value.slice(0, clamped)}${inserted}${value.slice(clamped)}`,
    cursor: clamped + inserted.length,
  };
}

export function cursorLineInfo(
  value: string,
  cursor: number,
): { line: number; column: number; lineStart: number; lineEnd: number } {
  const clamped = Math.max(0, Math.min(cursor, value.length));
  const lineStart = clamped === 0 ? 0 : value.lastIndexOf('\n', clamped - 1) + 1;
  const nextBreak = value.indexOf('\n', clamped);
  const lineEnd = nextBreak < 0 ? value.length : nextBreak;
  let line = 0;
  for (let index = 0; index < lineStart; index += 1) {
    if (value.charCodeAt(index) === 10) line += 1;
  }
  return { line, column: clamped - lineStart, lineStart, lineEnd };
}

export function lineHome(value: string, cursor: number): number {
  return cursorLineInfo(value, cursor).lineStart;
}

export function lineEnd(value: string, cursor: number): number {
  return cursorLineInfo(value, cursor).lineEnd;
}

/**
 * Move the cursor up or down one logical line, keeping the column when the
 * target line is long enough. Returns undefined when the draft is a single
 * line so the caller can fall back to history navigation.
 */
export function moveCursorVertical(
  value: string,
  cursor: number,
  delta: -1 | 1,
): number | undefined {
  if (!value.includes('\n')) return undefined;
  const info = cursorLineInfo(value, cursor);
  const lines = value.split('\n');
  const target = info.line + delta;
  if (target < 0 || target >= lines.length) return cursor;
  let start = 0;
  for (let index = 0; index < target; index += 1) {
    start += (lines[index]?.length ?? 0) + 1;
  }
  return start + Math.min(info.column, lines[target]?.length ?? 0);
}

export function renderComposerLines(value: string, cursor: number): string[] {
  const withCursor = `${value.slice(0, cursor)}|${value.slice(cursor)}`;
  return withCursor.split('\n');
}

export function visibleComposerLines(value: string, cursor: number, maxLines: number): string[] {
  const lines = renderComposerLines(value, cursor);
  if (lines.length <= maxLines) return lines;
  const { line } = cursorLineInfo(value, cursor);
  const start = Math.min(Math.max(0, line - maxLines + 1), lines.length - maxLines);
  return lines.slice(start, start + maxLines);
}

export function composerHeight(value: string, maxLines = MAX_COMPOSER_LINES): number {
  return Math.min(maxLines, Math.max(1, value.split('\n').length));
}
