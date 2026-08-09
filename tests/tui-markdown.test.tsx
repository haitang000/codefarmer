import { renderToString } from 'ink';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';

import { MarkdownView, parseInlineMarkdown } from '../src/tui/markdown.js';

function renderMarkdown(content: string): string {
  return renderToString(<MarkdownView content={content} />, { columns: 80 });
}

describe('parseInlineMarkdown', () => {
  it('splits bold, italic, inline code, and links into styled segments', () => {
    const segments = parseInlineMarkdown(
      'run **pnpm build** with `tsup` and _care_, see [docs](https://x.dev)',
    );

    const byText = Object.fromEntries(segments.map((segment) => [segment.text, segment]));
    expect(byText['pnpm build']?.bold).toBe(true);
    expect(byText.tsup?.code).toBe(true);
    expect(byText.care?.italic).toBe(true);
    expect(byText.docs?.bold).toBe(true);
    expect(byText[' (https://x.dev)']?.dim).toBe(true);
  });

  it('returns plain text unchanged when no markup is present', () => {
    expect(parseInlineMarkdown('hello world')).toEqual([{ key: 0, text: 'hello world' }]);
  });
});

describe('MarkdownView', () => {
  it('renders headings, bullets, and quotes as terminal blocks', () => {
    const output = renderMarkdown(['# Title', '- first item', '> quoted'].join('\n'));

    expect(output).toContain('Title');
    expect(output).toContain('• first item');
    expect(output).toContain('▍ quoted');
  });

  it('renders fenced code blocks and tolerates an unterminated fence while streaming', () => {
    const closed = renderMarkdown(['```ts', 'const a = 1;', '```'].join('\n'));
    expect(closed).toContain('const a = 1;');
    expect(closed).toContain('ts');

    const open = renderMarkdown(['```ts', 'const a = 1;'].join('\n'));
    expect(open).toContain('const a = 1;');
  });

  it('renders inline text content', () => {
    const output = renderMarkdown('plain answer with **emphasis**');
    expect(output).toContain('plain answer with');
    expect(output).toContain('emphasis');
  });

  it('keeps every markdown block on its own line inside the entry column box', () => {
    // The transcript wraps MarkdownView in a paddingLeft Box; a row layout
    // would fuse the sibling Text blocks into one text stream, placing the
    // next block next to the previous paragraph's wrapped tail. The column
    // layout keeps each block on its own line with correct break positions.
    const content = [
      'Environment check passed – the workspace is readable and contains the CodeFarmer project.',
      '> I\'m ready. What would you like me to do?',
      '```ts',
      'const a = 1;',
      '```',
      'after code block',
    ].join('\n');
    const output = renderToString(
      <Box paddingLeft={2} flexDirection="column">
        <MarkdownView content={content} />
      </Box>,
      { columns: 90 },
    );

    const trimmed = output.split('\n').map((line) => line.trimStart());
    // The quote block starts its own line instead of being fused after the
    // wrapped paragraph tail.
    expect(trimmed).toContain('▍ I\'m ready. What would you like me to do?');
    // The code fence and the following paragraph are also separate lines.
    expect(trimmed.some((line) => line.startsWith('┌'))).toBe(true);
    expect(trimmed).toContain('const a = 1;');
    expect(trimmed).toContain('after code block');
  });

  it('places consecutive paragraphs on separate lines inside the entry column box', () => {
    const output = renderToString(
      <Box paddingLeft={2} flexDirection="column">
        <MarkdownView
          content={[
            'first paragraph that is long enough to wrap around the terminal width boundary.',
            'second paragraph with no blank line between',
          ].join('\n')}
        />
      </Box>,
      { columns: 40 },
    );
    const trimmed = output.split('\n').map((line) => line.trimStart());
    const second = trimmed.findIndex((line) => line.startsWith('second paragraph'));
    expect(second).toBeGreaterThanOrEqual(0);
    // The second paragraph must not share a line with the first paragraph's
    // wrapped tail; it starts a fresh line after the wrap.
    expect(trimmed.slice(0, second).every((line) => !line.includes('second paragraph'))).toBe(
      true,
    );
  });
});
