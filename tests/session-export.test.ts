import { describe, expect, it } from 'vitest';

import { renderSessionExport } from '../src/cli/session-export.js';
import type { SessionRecord } from '../src/types.js';

function session(firstMessageContent = '请解释 `fence` 与 ``` 的区别'): SessionRecord {
  return {
    version: 1,
    id: 'session-1',
    workspace: '/workspace',
    provider: 'openai',
    model: 'gpt-test',
    baseURL: 'https://api.example.com/v1',
    status: 'completed',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:01:00.000Z',
    previousResponseId: 'resp-1',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: firstMessageContent,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: '完成，详情见下方。',
        createdAt: '2025-01-01T00:00:30.000Z',
        responseId: 'resp-1',
      },
    ],
    toolCalls: [
      {
        callId: 'call-1',
        toolName: 'list_files',
        arguments: { path: '.', maxDepth: 2 },
        success: true,
        approved: true,
        outputSummary: '3 files',
        startedAt: '2025-01-01T00:00:10.000Z',
        completedAt: '2025-01-01T00:00:11.000Z',
      },
    ],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 10,
      cachedInputTokens: 20,
    },
  };
}

describe('session export rendering', () => {
  it('serializes a session as pretty JSON', () => {
    const rendered = renderSessionExport(session(), 'json');

    expect(JSON.parse(rendered)).toEqual(session());
    expect(rendered).toContain('\n  "id": "session-1"');
  });

  it('renders a Markdown report with metadata, messages, and tool calls', () => {
    const rendered = renderSessionExport(session(), 'markdown');

    expect(rendered).toContain('# CodeFarmer 会话 session-1');
    expect(rendered).toContain('- 状态: completed');
    expect(rendered).toContain('- 提供方: openai');
    expect(rendered).toContain('- 模型: gpt-test');
    expect(rendered).toContain('- Base URL: https://api.example.com/v1');
    expect(rendered).toContain(
      '- 令牌用量: 输入 100 / 输出 50 / 总计 150 / 推理 10 / 缓存输入 20',
    );
    expect(rendered).toContain('- 响应 ID: `resp-1`');
    expect(rendered).toContain('## 消息');
    expect(rendered).toContain('### 用户 (2025-01-01T00:00:00.000Z)');
    expect(rendered).toContain('### 助手 (2025-01-01T00:00:30.000Z)');
    expect(rendered).toContain('## 工具调用');
    expect(rendered).toContain('### list_files (`call-1`)');
    expect(rendered).toContain('- 状态: 成功');
    expect(rendered).toContain('输出摘要:');
  });

  it('uses a longer fence than any backtick run inside message content', () => {
    const rendered = renderSessionExport(session('```\ncode\n```'), 'markdown');

    expect(rendered).toContain('````text');
    expect(rendered).toContain('```\ncode\n```');
  });

  it('marks empty sessions in Markdown', () => {
    const record = session();
    record.messages = [];
    record.toolCalls = [];

    const rendered = renderSessionExport(record, 'markdown');

    expect(rendered).toContain('（无消息）');
    expect(rendered).toContain('（无工具调用）');
  });
});
