import { describe, expect, it } from 'vitest';

import { formatTerminalTitle, normaliseSessionTitle } from '../src/tui/title.js';

describe('TUI titles', () => {
  it('prefixes the terminal window title with the idle dot by default', () => {
    expect(formatTerminalTitle('Fix login redirect')).toBe('● Fix login redirect | CodeFarmer');
    expect(formatTerminalTitle(undefined)).toBe('● CodeFarmer');
  });

  it('switches the title prefix with the agent status', () => {
    expect(formatTerminalTitle('Fix login redirect', 'running')).toBe(
      '⏳ Fix login redirect | CodeFarmer',
    );
    expect(formatTerminalTitle('Fix login redirect', 'completed')).toBe(
      '✅ Fix login redirect | CodeFarmer',
    );
    expect(formatTerminalTitle(undefined, 'running')).toBe('⏳ CodeFarmer');
  });

  it('removes control characters before rendering terminal UI text', () => {
    expect(normaliseSessionTitle(' Fix\u001B]0;unsafe\u0007 title\n ')).toBe('Fix ]0;unsafe title');
  });
});
