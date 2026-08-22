import { describe, expect, it } from 'vitest';

import {
  composerHeight,
  cursorLineInfo,
  insertAtCursor,
  lineEnd,
  lineHome,
  moveCursorVertical,
  renderComposerLines,
  visibleComposerLines,
} from '../src/tui/composer.js';

describe('TUI composer', () => {
  it('inserts text and newlines at the cursor', () => {
    expect(insertAtCursor('ab', 1, '\n')).toEqual({ value: 'a\nb', cursor: 2 });
    expect(insertAtCursor('', 0, 'hello')).toEqual({ value: 'hello', cursor: 5 });
  });

  it('reports line boundaries and moves vertically', () => {
    const value = 'one\ntwo\nthree';
    expect(cursorLineInfo(value, 5)).toMatchObject({
      line: 1,
      column: 1,
      lineStart: 4,
      lineEnd: 7,
    });
    expect(lineHome(value, 6)).toBe(4);
    expect(lineEnd(value, 5)).toBe(7);
    expect(moveCursorVertical(value, 1, 1)).toBe(5);
    expect(moveCursorVertical(value, 5, -1)).toBe(1);
    expect(moveCursorVertical('single', 3, -1)).toBeUndefined();
  });

  it('renders a cursor and windows long drafts', () => {
    expect(renderComposerLines('ab', 1)).toEqual(['a|b']);
    expect(renderComposerLines('a\nb', 2)).toEqual(['a', '|b']);
    const long = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(visibleComposerLines(long, long.length, 3)).toEqual(['c', 'd', 'e|']);
    expect(composerHeight(long)).toBe(5);
  });
});
