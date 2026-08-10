import { describe, expect, it } from 'vitest';

import {
  COMPACT_KEEP_RECENT_MESSAGES,
  compactSession,
  sessionContextChars,
} from '../src/core/session-compact.js';
import { DEFAULT_CONFIG } from '../src/infra/config.js';
import { ConfigError, ProviderError } from '../src/infra/errors.js';
import { ScriptedProvider } from '../src/providers/fake.js';
import type {
  ProviderEvent,
  ProviderRequest,
  SessionMessage,
  SessionRecord,
  SessionToolCall,
} from '../src/types.js';

function message(role: SessionMessage['role'], index: number): SessionMessage {
  return {
    id: `msg-${role}-${String(index)}`,
    role,
    content: `${role} turn ${String(index)}`,
    createdAt: new Date(1 + index).toISOString(),
  };
}

function session(
  messageCount: number,
  toolCalls: SessionToolCall[] = [],
  previousResponseId: string | undefined = 'response-before',
): SessionRecord {
  const messages: SessionMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    messages.push(message(index % 2 === 0 ? 'user' : 'assistant', index));
  }
  return {
    version: 1,
    id: 'session-compact-test',
    workspace: '/tmp',
    provider: 'fake',
    model: 'test-model',
    status: 'active',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    previousResponseId,
    messages,
    toolCalls,
  };
}

class RecordingProvider extends ScriptedProvider {
  readonly requests: ProviderRequest[] = [];

  override async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    yield* super.stream(request);
  }
}

describe('compactSession', () => {
  it('summarises early messages, keeps recent turns and clears the stored-response chain', async () => {
    const record = session(20);
    const provider = new RecordingProvider([
      [
        { type: 'text_delta', delta: 'User wants X.' },
        {
          type: 'response_completed',
          responseId: 'response-compact',
          outputText: 'User wants X.',
        },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } },
      ],
    ]);

    const result = await compactSession({
      session: record,
      provider,
      config: DEFAULT_CONFIG,
    });

    expect(result.summary).toBe('User wants X.');
    expect(result.originalMessageCount).toBe(20);
    expect(result.keptMessageCount).toBe(COMPACT_KEEP_RECENT_MESSAGES);
    expect(result.compressedMessageCount).toBe(20 - COMPACT_KEEP_RECENT_MESSAGES);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105 });

    expect(record.messages).toHaveLength(COMPACT_KEEP_RECENT_MESSAGES + 1);
    expect(record.messages[0]).toMatchObject({
      role: 'system',
      compressed: true,
    });
    expect(record.messages[0]?.content).toContain('User wants X.');
    // The newest turns stay verbatim, most recent last.
    expect(record.messages[record.messages.length - 1]?.content).toBe('assistant turn 19');
    expect(record.previousResponseId).toBeUndefined();
    expect(record.compactedAt).toBeDefined();
  });

  it('sends a store:false request with instructions, history and the tool audit trail', async () => {
    const record = session(20, [
      {
        callId: 'call-1',
        toolName: 'apply_patch',
        arguments: { path: 'src/a.ts' },
        success: true,
        approved: true,
        outputSummary: 'patched src/a.ts',
        startedAt: '2025-01-01T00:00:00.000Z',
      },
    ]);
    const provider = new RecordingProvider([
      [
        { type: 'text_delta', delta: 'Summary.' },
        {
          type: 'response_completed',
          responseId: 'response-compact',
          outputText: 'Summary.',
        },
      ],
    ]);

    await compactSession({ session: record, provider, config: DEFAULT_CONFIG });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      model: DEFAULT_CONFIG.model,
      reasoning: DEFAULT_CONFIG.reasoning,
      store: false,
      tools: [],
    });
    expect(provider.requests[0]?.previousResponseId).toBeUndefined();
    expect(provider.requests[0]?.instructions).toContain('compressing a long coding-agent');
    const input = provider.requests[0]?.input;
    expect(Array.isArray(input)).toBe(true);
    if (!Array.isArray(input)) throw new Error('Expected explicit-history input');
    // The tool audit trail is prepended as a reference document.
    expect(input[0]).toMatchObject({
      type: 'message',
      role: 'system',
      content: expect.stringContaining('Audit trail of tool calls') as string,
    });
    expect(input).toContainEqual({
      type: 'message',
      role: 'user',
      content: 'user turn 0',
    });
  });

  it('throws ConfigError when there is nothing worth compacting', async () => {
    const record = session(5);
    const provider = new RecordingProvider([]);

    await expect(
      compactSession({ session: record, provider, config: DEFAULT_CONFIG }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(record.messages).toHaveLength(5);
    expect(record.previousResponseId).toBe('response-before');
    expect(provider.requests).toHaveLength(0);
  });

  it('leaves the session untouched when the provider fails', async () => {
    const record = session(20);
    const provider = new RecordingProvider([
      [
        {
          type: 'error',
          error: { code: 'server_error', message: 'boom', retryable: true },
        },
      ],
    ]);
    const before = JSON.stringify(record);

    await expect(
      compactSession({ session: record, provider, config: DEFAULT_CONFIG }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(JSON.stringify(record)).toBe(before);
  });

  it('throws ProviderError when the summariser returns no text', async () => {
    const record = session(20);
    const provider = new RecordingProvider([
      [{ type: 'response_completed', responseId: 'response-empty', outputText: '' }],
    ]);

    await expect(
      compactSession({ session: record, provider, config: DEFAULT_CONFIG }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(record.messages).toHaveLength(20);
  });

  it('trims the summary to the configured maximum and keeps a marker suffix', async () => {
    const record = session(20);
    const longSummary = 'x'.repeat(10_000);
    const provider = new RecordingProvider([
      [
        { type: 'text_delta', delta: longSummary },
        {
          type: 'response_completed',
          responseId: 'response-long',
          outputText: longSummary,
        },
      ],
    ]);

    const result = await compactSession({
      session: record,
      provider,
      config: DEFAULT_CONFIG,
    });

    expect(result.summary).toHaveLength(8_000);
    expect(result.summary.endsWith('…')).toBe(true);
  });
});

describe('sessionContextChars', () => {
  it('sums the stored message content', () => {
    const record = session(4);
    const expected = record.messages.reduce((sum, item) => sum + item.content.length, 0);
    expect(sessionContextChars(record)).toBe(expected);
  });
});
