import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import type { ProviderEvent } from '../src/types.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe('OpenAICompatibleProvider', () => {
  it('forwards streamed reasoning_content as reasoning deltas', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        [
          `data: ${JSON.stringify({
            id: 'chatcmpl-thinking',
            choices: [{ delta: { reasoning_content: 'Inspect the workspace. ' } }],
            usage: null,
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'chatcmpl-thinking',
            choices: [{ delta: { reasoning_content: 'Then make the change.', content: 'Done.' } }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Test server has no port');

    const provider = new OpenAICompatibleProvider({
      provider: 'deepseek',
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    });
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: 'deepseek-reasoner',
      reasoning: 'auto',
      reasoningSummary: 'auto',
      input: 'Inspect the workspace.',
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: 'reasoning_delta',
      delta: 'Inspect the workspace. ',
    });
    expect(events).toContainEqual({
      type: 'reasoning_delta',
      delta: 'Then make the change.',
    });
    expect(events).toContainEqual({ type: 'text_delta', delta: 'Done.' });
  });

  it('maps explicit tool history and streamed tool calls to the shared provider protocol', async () => {
    let received = '';
    const server = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
      });
      request.on('end', () => {
        response.setHeader('content-type', 'text/event-stream');
        response.end(
          [
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              choices: [{ delta: { content: 'I will inspect it.' } }],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        function: { name: 'read_file', arguments: '{"path":' },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              choices: [
                {
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ].join(''),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Test server has no port');

    const provider = new OpenAICompatibleProvider({
      provider: 'deepseek',
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    });
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: 'deepseek-chat',
      reasoning: 'auto',
      instructions: 'You are a coding assistant.',
      input: [
        { type: 'message', role: 'user', content: 'Read the README.' },
        {
          type: 'function_call',
          callId: 'old-call',
          name: 'read_file',
          arguments: '{"path":"a"}',
          reasoningContent: 'I should inspect the file first.',
        },
        {
          type: 'function_call',
          callId: 'old-call-2',
          name: 'list_files',
          arguments: '{}',
        },
        { type: 'function_call_output', callId: 'old-call', output: '{"success":true}' },
        { type: 'function_call_output', callId: 'old-call-2', output: '{"success":true}' },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object' },
          readOnly: true,
        },
      ],
    })) {
      events.push(event);
    }

    const request = JSON.parse(received) as { messages: Record<string, unknown>[] };
    expect(request).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
    });
    expect(request.messages[2]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'I should inspect the file first.',
      tool_calls: [{ id: 'old-call' }, { id: 'old-call-2' }],
    });
    expect(request.messages.slice(3).map((message) => message.tool_call_id)).toEqual([
      'old-call',
      'old-call-2',
    ]);
    expect(events).toContainEqual({ type: 'text_delta', delta: 'I will inspect it.' });
    expect(events).toContainEqual({
      type: 'tool_call',
      call: { callId: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' },
    });
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(events).toContainEqual({
      type: 'response_completed',
      responseId: 'chatcmpl-1',
      outputText: 'I will inspect it.',
      finishReason: 'tool_calls',
    });
  });

  it('surfaces a provider error embedded in an SSE stream', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        `data: ${JSON.stringify({
          error: { code: 'rate_limit_exceeded', message: 'Too many requests.' },
        })}\n\n`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Test server has no port');

    const provider = new OpenAICompatibleProvider({
      provider: 'deepseek',
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    });
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: 'deepseek-chat',
      reasoning: 'auto',
      input: 'Hello.',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'PROVIDER_STREAM_ERROR',
          message: 'Too many requests.',
          retryable: true,
        },
      },
    ]);
  });

  it('accepts an SSE [DONE] sentinel with a BOM and trailing carriage return', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.end('\uFEFFdata: [DONE]\r');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Test server has no port');

    const provider = new OpenAICompatibleProvider({
      provider: 'deepseek',
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    });
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: 'deepseek-chat',
      reasoning: 'auto',
      input: 'Hello.',
    })) {
      events.push(event);
    }

    expect(
      events.some(
        (event) =>
          event.type === 'response_completed' &&
          event.outputText === '' &&
          event.finishReason === 'completed',
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});
