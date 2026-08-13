export const TUI_PRODUCT_TITLE = 'CodeFarmer';

/** Terminal window title indicator states. */
export type TuiTitleStatus = 'running' | 'completed' | 'idle';

const TUI_TITLE_STATUS_PREFIX: Record<TuiTitleStatus, string> = {
  running: '⏳',
  completed: '✅',
  idle: '●',
};

/**
 * Convert an optional session title into one safe for terminal UI surfaces.
 * Control characters are stripped because titles can originate from user
 * prompts and must never be allowed to terminate an OSC title sequence.
 */
export function normaliseSessionTitle(title: string | undefined): string | undefined {
  const normalised = title
    ?.split('')
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127 ? character : ' ';
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalised === undefined || normalised.length === 0 ? undefined : normalised;
}

export function formatTerminalTitle(
  title: string | undefined,
  status: TuiTitleStatus = 'idle',
): string {
  const sessionTitle = normaliseSessionTitle(title);
  const base =
    sessionTitle === undefined ? TUI_PRODUCT_TITLE : `${sessionTitle} | ${TUI_PRODUCT_TITLE}`;
  return `${TUI_TITLE_STATUS_PREFIX[status]} ${base}`;
}
