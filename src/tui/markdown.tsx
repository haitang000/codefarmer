import React from 'react';
import { Text } from 'ink';

interface InlineSegment {
  key: number;
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  dim?: boolean;
}

// 按行解析，行内不会出现换行符，因此字符类无需排除换行。
const INLINE_PATTERN = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu;

/**
 * Splits a Markdown line into styled inline segments. The grammar is
 * intentionally small so streaming deltas re-parse cheaply.
 */
export function parseInlineMarkdown(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  let key = 0;
  const pushPlain = (text: string): void => {
    if (text.length > 0) segments.push({ key: key++, text });
  };
  for (const match of line.matchAll(INLINE_PATTERN)) {
    const index = match.index;
    pushPlain(line.slice(lastIndex, index));
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      segments.push({ key: key++, text: token.slice(2, -2), bold: true });
    } else if (token.startsWith('`')) {
      segments.push({ key: key++, text: token.slice(1, -1), code: true });
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
      const label = link?.[1] ?? token;
      const href = link?.[2];
      segments.push({ key: key++, text: label, bold: true });
      if (href !== undefined && href !== label) {
        segments.push({ key: key++, text: ` (${href})`, dim: true });
      }
    } else {
      segments.push({ key: key++, text: token.slice(1, -1), italic: true });
    }
    lastIndex = index + token.length;
  }
  pushPlain(line.slice(lastIndex));
  return segments;
}

function InlineText({ line }: { line: string }): React.ReactElement {
  const segments = parseInlineMarkdown(line);
  return (
    <Text wrap="wrap">
      {segments.map((segment) => (
        <Text
          key={segment.key}
          bold={segment.bold === true}
          italic={segment.italic === true}
          inverse={segment.code === true}
          dimColor={segment.dim === true}
          {...(segment.code === true ? { color: 'cyan' as const } : {})}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

export function MarkdownView({ content }: { content: string }): React.ReactElement {
  const lines = content.split(/\r?\n/u);
  const blocks: React.ReactElement[] = [];
  let key = 0;
  let inCode = false;
  let codeLanguage = '';
  let codeLines: string[] = [];

  const flushCode = (): void => {
    if (codeLines.length > 0 || codeLanguage.length > 0) {
      blocks.push(
        <Text key={key++} color="gray" wrap="wrap">
          {`┌${codeLanguage.length > 0 ? ` ${codeLanguage} ` : ''}${'─'.repeat(
            Math.max(0, 24 - codeLanguage.length),
          )}\n${codeLines.join('\n')}\n└${'─'.repeat(24)}`}
        </Text>,
      );
    }
    codeLines = [];
    codeLanguage = '';
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '');

    if (inCode) {
      if (line.trimStart().startsWith('```')) {
        inCode = false;
        flushCode();
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = /^\s*```(\S*)/u.exec(line);
    if (fence) {
      inCode = true;
      codeLanguage = fence[1] ?? '';
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const title = heading[2] ?? '';
      const rendered = parseInlineMarkdown(title);
      blocks.push(
        <Text
          key={key++}
          bold
          {...(level <= 1
            ? { color: 'cyan' as const }
            : level === 2
              ? { color: 'blue' as const }
              : {})}
          dimColor={level >= 4}
          wrap="wrap"
        >
          {level <= 2 ? `${'#'.repeat(level)} ` : ''}
          {rendered.map((segment) => (
            <Text
              key={segment.key}
              bold
              italic={segment.italic === true}
              inverse={segment.code === true}
            >
              {segment.text}
            </Text>
          ))}
        </Text>,
      );
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/u.test(line.trim())) {
      blocks.push(
        <Text key={key++} dimColor>
          {'─'.repeat(24)}
        </Text>,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) {
      blocks.push(
        <Text key={key++} dimColor wrap="wrap">
          {'▍ '}
          {quote[1] ?? ''}
        </Text>,
      );
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (bullet) {
      const indent = bullet[1] ?? '';
      const marker = bullet[2] ?? '-';
      const text = bullet[3] ?? '';
      blocks.push(
        <Text key={key++} wrap="wrap">
          <Text color={/\d/u.test(marker) ? 'blue' : 'yellow'}>
            {`${indent}${/\d/u.test(marker) ? marker : '•'} `}
          </Text>
          {parseInlineMarkdown(text).map((segment) => (
            <Text
              key={segment.key}
              bold={segment.bold === true}
              italic={segment.italic === true}
              inverse={segment.code === true}
              dimColor={segment.dim === true}
              {...(segment.code === true ? { color: 'cyan' as const } : {})}
            >
              {segment.text}
            </Text>
          ))}
        </Text>,
      );
      continue;
    }

    if (line.length === 0) {
      blocks.push(<Text key={key++}> </Text>);
      continue;
    }
    blocks.push(<InlineText key={key++} line={line} />);
  }

  // An unterminated fence during streaming still renders as code.
  if (inCode) flushCode();

  return <>{blocks}</>;
}
