import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenAIProvider } from '../src/providers/openai.js';
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

describe('OpenAIProvider Base URL', () => {
  it('sends SDK requests to the configured endpoint', async () => {
    let requestedPath = '';
    let authorization = '';
    const server = createServer((request, response) => {
      requestedPath = request.url ?? '';
      authorization = request.headers.authorization ?? '';
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'gpt-5.6-sol',
          object: 'model',
          created: 0,
          owned_by: 'test',
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Test server has no TCP port');

    const provider = new OpenAIProvider({
      apiKey: 'test-api-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
      connectionModel: 'custom-model',
      maxRetries: 0,
    });
    await provider.checkConnection();

    expect(requestedPath).toBe('/v1/models/custom-model');
    expect(authorization).toBe('Bearer test-api-key');
  });

  it('reports truncated responses as incomplete completions instead of errors', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        [
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'Partial output',
          })}\n\n`,
          `event: response.incomplete\ndata: ${JSON.stringify({
            type: 'response.incomplete',
            response: {
              id: 'resp-incomplete',
              object: 'response',
              status: 'incomplete',
              output_text: 'Partial output',
              incomplete_details: { reason: 'max_output_tokens' },
              usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            },
          })}\n\n`,
        ].join(''),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Test server has no TCP port');

    const provider = new OpenAIProvider({
      apiKey: 'test-api-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
      maxRetries: 0,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: 'test-model',
      reasoning: 'medium',
      verbosity: 'high',
      reasoningSummary: 'detailed',
      input: 'hello',
      store: false,
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'error')).toBe(false);
    const completed = events.find((event) => event.type === 'response_completed');
    expect(completed).toMatchObject({
      type: 'response_completed',
      responseId: 'resp-incomplete',
      outputText: 'Partial output',
      finishReason: 'incomplete',
    });
    expect(events.some((event) => event.type === 'usage')).toBe(true);
  });

  it('requests reasoning summaries and maps them to reasoning_delta events', async () => {
    let requestBody = '';
    const server = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        requestBody += chunk.toString('utf8');
      });
      request.on('end', () => {
        response.setHeader('content-type', 'text/event-stream');
        response.end(
          [
            `event: response.reasoning_summary_part.added\ndata: ${JSON.stringify({
              type: 'response.reasoning_summary_part.added',
              item_id: 'rs-1',
              output_index: 0,
              summary_index: 0,
              part: { type: 'summary_text', text: '' },
            })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
              type: 'response.reasoning_summary_text.delta',
              item_id: 'rs-1',
              output_index: 0,
              summary_index: 0,
              delta: 'Let me inspect ',
            })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
              type: 'response.reasoning_summary_text.delta',
              item_id: 'rs-1',
              output_index: 0,
              summary_index: 0,
              delta: 'the workspace.',
            })}\n\n`,
            `event: response.reasoning_summary_part.added\ndata: ${JSON.stringify({
              type: 'response.reasoning_summary_part.added',
              item_id: 'rs-1',
              output_index: 0,
              summary_index: 1,
              part: { type: 'summary_text', text: '' },
            })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
              type: 'response.reasoning_summary_text.delta',
              item_id: 'rs-1',
              output_index: 0,
              summary_index: 1,
              delta: 'Then apply the patch.',
            })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: 'response.output_text.delta',
              item_id: 'msg-1',
              output_index: 1,
              content_index: 0,
              delta: 'Done.',
            })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp-thinking',
                object: 'response',
                status: 'completed',
                output_text: 'Done.',
                usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
              },
            })}\n\n`,
          ].join(''),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Test server has no TCP port');

    const provider = new OpenAIProvider({
      apiKey: 'test-api-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
      maxRetries: 0,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: 'test-model',
      reasoning: 'medium',
      verbosity: 'high',
      reasoningSummary: 'detailed',
      maxOutputTokens: 512,
      input: 'hello',
      store: false,
    })) {
      events.push(event);
    }

    // 请求必须开启推理摘要，否则 API 不会流式输出思考过程。
    const parsedBody = JSON.parse(requestBody) as {
      reasoning?: { summary?: string };
      text?: { verbosity?: string };
      max_output_tokens?: number;
    };
    expect(parsedBody.reasoning?.summary).toBe('detailed');
    expect(parsedBody.text?.verbosity).toBe('high');
    expect(parsedBody.max_output_tokens).toBe(512);

    const reasoningDeltas = events
      .filter((event): event is Extract<ProviderEvent, { type: 'reasoning_delta' }> =>
        event.type === 'reasoning_delta',
      )
      .map((event) => event.delta);
    // 多段摘要之间用空行分隔。
    expect(reasoningDeltas).toEqual([
      'Let me inspect ',
      'the workspace.',
      '\n\n',
      'Then apply the patch.',
    ]);
    // 思考内容与正文互不混淆。
    const textDeltas = events
      .filter((event): event is Extract<ProviderEvent, { type: 'text_delta' }> =>
        event.type === 'text_delta',
      )
      .map((event) => event.delta);
    expect(textDeltas).toEqual(['Done.']);
  });

  it('omits the reasoning effort field when set to auto so the model decides', async () => {
    let requestBody = '';
    const server = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        requestBody += chunk.toString('utf8');
      });
      request.on('end', () => {
        response.setHeader('content-type', 'text/event-stream');
        response.end(
          [
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'Done.',
            })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp-auto',
                object: 'response',
                status: 'completed',
                output_text: 'Done.',
                usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
              },
            })}\n\n`,
          ].join(''),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Test server has no TCP port');

    const provider = new OpenAIProvider({
      apiKey: 'test-api-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
      maxRetries: 0,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: 'test-model',
      reasoning: 'auto',
      verbosity: 'low',
      reasoningSummary: 'none',
      input: 'hello',
      store: false,
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.type === 'error')).toBe(false);

    const parsedBody = JSON.parse(requestBody) as {
      reasoning?: { effort?: string; summary?: string };
      text?: { verbosity?: string };
    };
    // efficient default: let the model choose reasoning and omit visible summaries.
    expect(parsedBody.reasoning?.effort).toBeUndefined();
    expect(parsedBody.reasoning).toBeUndefined();
    expect(parsedBody.text?.verbosity).toBe('low');
  });

  it('surfaces the effort the model picked under auto so the UI can announce switches', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        [
          `event: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp-effort',
              object: 'response',
              status: 'completed',
              output_text: 'Done.',
              reasoning: { effort: 'high' },
              usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
            },
          })}\n\n`,
        ].join(''),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Test server has no TCP port');

    const provider = new OpenAIProvider({
      apiKey: 'test-api-key',
      baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
      maxRetries: 0,
    });

    const collect = async (reasoning: 'auto' | 'medium'): Promise<ProviderEvent[]> => {
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream({
        model: 'test-model',
        reasoning,
        verbosity: 'low',
        reasoningSummary: 'none',
        input: 'hello',
        store: false,
      })) {
        events.push(event);
      }
      return events;
    };

    // 'auto' leaves the effort to the model; the echoed choice must surface.
    const autoEvents = await collect('auto');
    expect(
      autoEvents.some(
        (event) => event.type === 'reasoning_effort' && event.effort === 'high',
      ),
    ).toBe(true);

    // An explicit effort was user-chosen, not agent-chosen; keep it silent.
    const explicitEvents = await collect('medium');
    expect(explicitEvents.some((event) => event.type === 'reasoning_effort')).toBe(false);
  });
});
