import { describe, expect, it } from 'vitest';

import { formatTerminalTitle, normaliseSessionTitle } from '../src/tui/title.js';

describe('TUI titles', () => {
  it('uses the session title in the terminal window title', () => {
    expect(formatTerminalTitle('Fix login redirect')).toBe('Fix login redirect | CodeFarmer');
    expect(formatTerminalTitle(undefined)).toBe('CodeFarmer');
  });

  it('removes control characters before rendering terminal UI text', () => {
    expect(normaliseSessionTitle(' Fix\u001B]0;unsafe\u0007 title\n ')).toBe('Fix ]0;unsafe title');
  });
});
