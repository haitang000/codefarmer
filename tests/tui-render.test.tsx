import { Box, renderToString, Text } from 'ink';
import { describe, expect, it } from 'vitest';

import type { AgentRuntime } from '../src/cli/runtime.js';
import { DEFAULT_CONFIG } from '../src/infra/config.js';
import {
  ClippedEntry,
  ApprovalModal,
  EffortPicker,
  EntryView,
  appendToolEntryAtResponseBoundary,
  runtimeEntries,
  TuiApp,
  assistantLines,
  wrapToLines,
  estimateContextTokens,
  formatNumber,
  formatWorkspaceStats,
  usageBar,
} from '../src/tui/App.js';
import { MarkdownView } from '../src/tui/markdown.js';
import { TuiInteractionBridge } from '../src/tui/runtime.js';

function mockRuntime(): AgentRuntime {
  const now = new Date(0).toISOString();
  return {
    workspace: 'C:\\workspace',
    config: { ...DEFAULT_CONFIG, model: 'test-model' },
    session: {
      version: 1,
      id: 'session-render-test',
      title: 'Fix login redirect',
      workspace: 'C:\\workspace',
      provider: 'test',
      model: 'test-model',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      messages: [],
      toolCalls: [],
    },
    sessions: {} as AgentRuntime['sessions'],
    transactions: {} as AgentRuntime['transactions'],
    logger: {} as AgentRuntime['logger'],
    runner: {} as AgentRuntime['runner'],
  };
}

describe('TUI rendering', () => {
  it('formats workspace stats with status and model usage charts', () => {
    const output = formatWorkspaceStats({
      totalSessions: 2,
      sessionsWithUsage: 2,
      statusCounts: { active: 0, completed: 1, cancelled: 0, failed: 1 },
      usage: {
        inputTokens: 1_200,
        outputTokens: 300,
        totalTokens: 1_500,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
      totalMessages: 5,
      totalToolCalls: 2,
      recent: { last7Days: 2, last30Days: 2 },
      byModel: [
        {
          model: 'gpt-5-mini',
          provider: 'openai',
          sessions: 2,
          usage: {
            inputTokens: 1_200,
            outputTokens: 300,
            totalTokens: 1_500,
            reasoningTokens: 0,
            cachedInputTokens: 0,
          },
          estimatedCostUsd: 0.003,
          priceMatched: true,
        },
      ],
      costUnknownModels: [],
      estimatedCostUsd: 0.003,
    });

    expect(output).toContain('Status');
    expect(output).toContain('Tokens by model');
    expect(output).toContain('gpt-5-mini');
    expect(output).toContain('█');
  });

  it('keeps each streamed response before the tool that follows it', () => {
    const firstAssistant = {
      id: 'assistant-1',
      kind: 'assistant' as const,
      content: '先检查项目。',
    };
    const tool = {
      id: 'tool-call-1',
      kind: 'tool' as const,
      content: 'list_files',
      tool: {
        callId: 'call-1',
        name: 'list_files',
        status: 'requested' as const,
      },
    };
    const afterTool = appendToolEntryAtResponseBoundary(
      [firstAssistant],
      firstAssistant.id,
      true,
      tool,
    );
    const transcript = [
      ...afterTool,
      { id: 'assistant-2', kind: 'assistant' as const, content: '检查完成。' },
    ];

    expect(transcript.map((entry) => entry.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(transcript.map((entry) => entry.content)).toEqual([
      '先检查项目。',
      'list_files',
      '检查完成。',
    ]);
  });

  it('removes an empty assistant placeholder when the response becomes a tool call', () => {
    const placeholder = { id: 'assistant-1', kind: 'assistant' as const, content: '' };
    const tool = {
      id: 'tool-call-1',
      kind: 'tool' as const,
      content: 'list_files',
      tool: { callId: 'call-1', name: 'list_files', status: 'requested' as const },
    };

    expect(appendToolEntryAtResponseBoundary([placeholder], placeholder.id, false, tool)).toEqual([
      tool,
    ]);
  });

  it('places tool results before the assistant response in a restored session', () => {
    const runtime = mockRuntime();
    const session = runtime.session;
    if (session === undefined) throw new Error('expected a mock session');
    session.messages = [
      { id: 'user-1', role: 'user', content: 'inspect', createdAt: '2026-01-01T00:00:00.000Z' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'The inspection is complete.',
        createdAt: '2026-01-01T00:00:00.003Z',
      },
    ];
    session.toolCalls = [
      {
        callId: 'tool-1',
        toolName: 'read_file',
        arguments: { path: 'README.md' },
        success: true,
        startedAt: '2026-01-01T00:00:00.001Z',
        completedAt: '2026-01-01T00:00:00.002Z',
      },
    ];

    const entries = runtimeEntries(runtime);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'tool', 'assistant']);
  });

  it('renders approval in flow between transcript content and the input', () => {
    const output = renderToString(
      <Box flexDirection="column">
        <Text>Assistant response</Text>
        <ApprovalModal
          approval={{
            request: {
              kind: 'command',
              title: 'Push Git changes',
              detail: '["git","push","origin","main"]',
            },
          }}
          columns={80}
          rows={30}
        />
        <Text>Input prompt</Text>
      </Box>,
      { columns: 80 },
    );

    expect(output.indexOf('Assistant response')).toBeLessThan(output.indexOf('Approval required'));
    expect(output.indexOf('Approval required')).toBeLessThan(output.indexOf('Input prompt'));
  });

  it('renders a non-empty workspace screen without a live terminal', () => {
    const runtime = mockRuntime();
    const bridge = new TuiInteractionBridge();
    const output = renderToString(
      <TuiApp
        initialRuntime={runtime}
        runtimeFactory={() => Promise.resolve(runtime)}
        bridge={bridge}
      />,
      { columns: 90 },
    );

    expect(output.trim().length).toBeGreaterThan(0);
    expect(output).toContain('CodeFarmer');
    expect(output).toContain('Fix login redirect');
    expect(output).toContain('C:\\workspace');
    expect(output).toContain('test-model');
    expect(output).toContain('Ready');
  });

  it('renders the effort picker as a horizontal slider with the cursor under the selection', () => {
    const output = renderToString(<EffortPicker current="medium" selected={5} />, {
      columns: 100,
    });

    expect(output).toContain('思考深度');
    expect(output).toContain('（当前 medium）');
    expect(output).toContain('←/→ 调整 · Enter 确认 · Esc 取消');

    const lines = output.split('\n');
    const labelsLine = lines.find((line) => line.includes('none') && line.includes('xhigh'));
    const markerLine = lines.find((line) => line.includes('▲'));
    expect(labelsLine).toBeDefined();
    expect(markerLine).toBeDefined();
    // Claude Code 式滑轨：▲ 游标必须对准选中标签 xhigh 的中点（偏移 2 列）。
    if (labelsLine !== undefined && markerLine !== undefined) {
      expect(markerLine.indexOf('▲')).toBe(labelsLine.indexOf('xhigh') + 2);
    }
  });

  it('shows changed-line stats on successful file mutation tool lines', () => {
    const runtime = mockRuntime();
    const now = new Date(0).toISOString();
    const session = runtime.session;
    if (session === undefined) throw new Error('expected a mock session');
    session.toolCalls = [
      {
        callId: 'patch-1',
        toolName: 'apply_patch',
        arguments: { path: 'src/tui/types.ts' },
        success: true,
        outputSummary: 'modify: src/tui/types.ts (+3 -2)',
        startedAt: now,
        completedAt: now,
      },
    ];
    const bridge = new TuiInteractionBridge();
    const output = renderToString(
      <TuiApp
        initialRuntime={runtime}
        runtimeFactory={() => Promise.resolve(runtime)}
        bridge={bridge}
      />,
      { columns: 90 },
    );

    expect(output).toContain('apply_patch');
    expect(output).toContain('+3 -2');
  });

  it('keeps assistant markdown blocks on separate lines instead of fusing them', () => {
    // A long paragraph plus a quote block: with the transcript box laid out
    // as a row, the sibling Text blocks fuse into one text stream and the
    // quote ends up next to the paragraph's wrapped tail. Column layout
    // keeps every block on its own line.
    const runtime = mockRuntime();
    const now = new Date(0).toISOString();
    const session = runtime.session;
    if (session === undefined) throw new Error('expected a mock session');
    session.messages = [
      { id: 'u-1', role: 'user', content: 'test', createdAt: now },
      {
        id: 'a-1',
        role: 'assistant',
        content: [
          'Environment check passed – the workspace is readable and contains the CodeFarmer project.',
          "> I'm ready. What would you like me to do?",
        ].join('\n'),
        createdAt: now,
      },
    ];
    const bridge = new TuiInteractionBridge();
    const output = renderToString(
      <TuiApp
        initialRuntime={runtime}
        runtimeFactory={() => Promise.resolve(runtime)}
        bridge={bridge}
      />,
      { columns: 90 },
    );

    const trimmed = output.split('\n').map((line) => line.trimStart());
    // The quote block starts its own line, not fused after the wrapped
    // paragraph tail.
    expect(trimmed).toContain("▍ I'm ready. What would you like me to do?");
  });

  it('estimates assistant line counts matching the real render for CJK text', () => {
    // The scroll and clipping helpers must wrap text exactly like Ink does
    // (display-width aware, breaking at spaces). A naive character-count
    // split would count two characters per CJK glyph and underestimate the
    // rendered line count, so the tail of the message gets clipped.
    const columns = 40;
    const content = [
      '第一段：这是一段比较长的中文内容，用来验证换行位置的正确性，保证每个汉字都能完整显示。',
      '> 引用内容也要在同样位置换行。',
      '```ts',
      'const a = 1; // 代码行',
      '```',
      '最后一段普通文本。',
    ].join('\n');
    const rendered = renderToString(
      <Box paddingLeft={2} flexDirection="column">
        <MarkdownView content={content} />
      </Box>,
      { columns },
    );
    const renderedLines = rendered.trimEnd().split('\n').length;
    const estimated = assistantLines(content, columns - 2).length;
    expect(estimated).toBe(renderedLines);
  });

  it('breaks English text at spaces instead of splitting words', () => {
    const lines = wrapToLines(
      'first paragraph that is long enough to wrap around the terminal width boundary.',
      38,
    );
    expect(lines.some((line) => line.includes('boundary.'))).toBe(true);
    // A character-count split would cut the word mid-way, leaving a
    // "…bounda" tail on one line and a "ry." fragment on the next.
    expect(lines.some((line) => line.endsWith('bounda'))).toBe(false);
    expect(lines.some((line) => line.startsWith('ry.'))).toBe(false);
  });

  it('preserves Markdown blocks when a transcript entry is clipped', () => {
    const output = renderToString(
      <ClippedEntry
        entry={{
          id: 'a-1',
          kind: 'assistant',
          content: ['# Heading', '- item', '> quote'].join('\n'),
        }}
        skip={1}
        take={3}
        width={80}
      />,
      { columns: 80 },
    );

    expect(output).toContain('• item');
    expect(output).toContain('▍ quote');
    expect(output).not.toContain('- item');
    expect(output).not.toContain('> quote');
  });

  it('shows assistant reasoning only when thinking display is enabled', () => {
    const entry = {
      id: 'a-1',
      kind: 'assistant' as const,
      content: 'Final answer.',
      reasoning: 'First inspect the workspace, then apply the patch.',
    };

    const hidden = renderToString(<EntryView entry={entry} width={90} />, { columns: 90 });
    expect(hidden).toContain('Final answer.');
    expect(hidden).not.toContain('Thinking');
    expect(hidden).not.toContain('inspect the workspace');

    const visible = renderToString(<EntryView entry={entry} width={90} showThinking />);
    const visibleLines = visible.split('\n');
    expect(visible).toContain('✦ Thinking');
    expect(visible).toContain('First inspect the workspace, then apply the patch.');
    // 思考块位于正文之前。
    const thinkingIndex = visibleLines.findIndex((line) => line.includes('✦ Thinking'));
    const answerIndex = visibleLines.findIndex((line) => line.includes('Final answer.'));
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(answerIndex).toBeGreaterThan(thinkingIndex);
  });
});

describe('context usage helpers', () => {
  it('formats numbers with thousands separators', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(12345)).toBe('12,345');
    expect(formatNumber(128000)).toBe('128,000');
  });

  it('estimates tokens from characters (ASCII ≈ 4 chars per token, wide chars ≈ 1)', () => {
    expect(estimateContextTokens('')).toBe(0);
    expect(estimateContextTokens('abc')).toBe(1);
    expect(estimateContextTokens('abcd')).toBe(1);
    expect(estimateContextTokens('abcdefghi')).toBe(3); // ceil(9 / 4)
    expect(estimateContextTokens('你好')).toBe(2);
    expect(estimateContextTokens('hello 你好')).toBe(4); // ceil(6 / 4) + 2
  });

  it('renders a fixed-width usage bar clamped to the ratio', () => {
    expect(usageBar(0, 10)).toBe('░'.repeat(10));
    expect(usageBar(1, 10)).toBe('█'.repeat(10));
    expect(usageBar(0.5, 10)).toBe('█████░░░░░');
    expect(usageBar(1.5, 10)).toBe('█'.repeat(10));
    expect(usageBar(-1, 10)).toBe('░'.repeat(10));
    expect(usageBar(0.05, 20)).toBe('█' + '░'.repeat(19));
  });
});
