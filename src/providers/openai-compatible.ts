import { randomUUID } from 'node:crypto';

import type {
  AgentProvider,
  ProviderEvent,
  ProviderInput,
  ProviderRequest,
  ProviderToolCall,
  ProviderId,
  ToolDefinition,
} from '../types.js';

interface ChatToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

interface ChatChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: ChatToolCall[];
  };
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: ChatToolCall[];
  };
  finish_reason?: string | null;
}

interface ChatResponse {
  id?: string;
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

interface ChatStreamError {
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
}

interface CollectedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** DeepSeek v4 defaults to high reasoning, so auto must not silently become expensive. */
function deepSeekGenerationOptions(request: ProviderRequest): Record<string, unknown> {
  if (request.model !== 'deepseek-v4-flash' && request.model !== 'deepseek-v4-pro') return {};
  if (request.reasoning === 'none') return { thinking: { type: 'disabled' } };
  const effort =
    request.reasoning === 'auto' || request.reasoning === 'low'
      ? 'low'
      : request.reasoning === 'medium' || request.reasoning === 'high'
        ? 'high'
        : 'max';
  return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

function messages(input: string | ProviderInput[], instructions?: string): unknown[] {
  const result: unknown[] = [];
  if (instructions !== undefined) result.push({ role: 'system', content: instructions });
  if (typeof input === 'string') return [...result, { role: 'user', content: input }];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item === undefined) continue;
    if (item.type === 'message') {
      result.push({
        role: item.role === 'developer' ? 'system' : item.role,
        content: item.content,
      });
    } else if (item.type === 'function_call') {
      // OpenAI-compatible APIs require one assistant message containing the
      // complete parallel tool-call batch, followed immediately by tool
      // messages for each call. Splitting calls into separate assistant
      // messages makes DeepSeek reject the next request.
      const calls = [item];
      while (input[index + 1]?.type === 'function_call') {
        index += 1;
        const next = input[index];
        if (next?.type === 'function_call') calls.push(next);
      }
      const reasoningContent = calls.find(
        (call) => call.reasoningContent !== undefined,
      )?.reasoningContent;
      result.push({
        role: 'assistant',
        content: null,
        ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
        tool_calls: calls.map((call) => ({
          id: call.callId,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
    } else {
      result.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
    }
  }
  return result;
}

function tools(definitions: ToolDefinition[] | undefined): unknown[] | undefined {
  return definitions?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function usage(response: ChatResponse): ProviderEvent | undefined {
  if (response.usage == null) return undefined;
  const inputTokens = response.usage.prompt_tokens ?? 0;
  const outputTokens = response.usage.completion_tokens ?? 0;
  return {
    type: 'usage',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: response.usage.total_tokens ?? inputTokens + outputTokens,
    },
  };
}

function appendToolCalls(
  target: Map<number, CollectedToolCall>,
  calls: ChatToolCall[] | undefined,
): void {
  for (const call of calls ?? []) {
    const index = call.index ?? target.size;
    const existing = target.get(index);
    if (existing === undefined) {
      target.set(index, {
        id: call.id ?? randomUUID(),
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '',
      });
      continue;
    }
    if (call.id !== undefined) existing.id = call.id;
    if (call.function?.name !== undefined) existing.name += call.function.name;
    if (call.function?.arguments !== undefined) existing.arguments += call.function.arguments;
  }
}

function providerError(status: number, body: string): ProviderEvent {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    message = parsed.error?.message ?? body;
  } catch {
    // Keep a non-JSON upstream body as the user-facing error message.
  }
  return {
    type: 'error',
    error: {
      code:
        status === 401 || status === 403 ? 'API_KEY_INVALID' : `PROVIDER_HTTP_${String(status)}`,
      message: message || `Provider request failed with HTTP ${String(status)}`,
      retryable: status === 408 || status === 409 || status === 429 || status >= 500,
    },
  };
}

function splitSseFrames(buffer: string): { frames: string[]; remainder: string } {
  // DeepSeek uses CRLF in production and some proxies normalize it to lone
  // CR. Normalize both forms before looking for SSE record boundaries.
  const normalized = buffer.replace(/\r\n?/gu, '\n');
  const frames = normalized.split('\n\n');
  return { frames: frames.slice(0, -1), remainder: frames.at(-1) ?? '' };
}

function ssePayload(frame: string): string | undefined {
  const payload = frame
    .replace(/^\uFEFF/u, '')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  // A UTF-8 BOM is allowed at the start of a text stream, but it is not part
  // of the JSON or the [DONE] sentinel. Some proxies preserve it per frame.
  const normalized = payload.replace(/^\uFEFF/u, '').trimEnd();
  return normalized.length === 0 ? undefined : normalized;
}

function retryableStreamError(message: string, code: string | number | undefined): boolean {
  const details = `${message} ${String(code ?? '')}`;
  return (
    code === 408 ||
    code === 409 ||
    code === 429 ||
    (typeof code === 'number' && code >= 500) ||
    /rate.?limit|temporar|timeout|unavailable|overload|internal.?server/iu.test(details)
  );
}

function streamError(payload: unknown): ProviderEvent | undefined {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return undefined;
  const error = (payload as ChatStreamError).error;
  if (error === undefined) return undefined;
  const suppliedMessage = error.message?.trim();
  const message =
    suppliedMessage === undefined || suppliedMessage.length === 0
      ? 'Provider returned an error event in its stream.'
      : suppliedMessage;
  const code = error.code ?? error.type;
  return {
    type: 'error',
    error: {
      code: /api.?key|auth/iu.test(`${String(code ?? '')} ${message}`)
        ? 'API_KEY_INVALID'
        : 'PROVIDER_STREAM_ERROR',
      message,
      retryable: retryableStreamError(message, error.code),
    },
  };
}

function invalidStreamError(error: unknown): ProviderEvent {
  const reason = error instanceof Error && error.message.length > 0 ? ` (${error.message})` : '';
  return {
    type: 'error',
    error: {
      code: 'PROVIDER_STREAM_INVALID',
      message: `Provider returned invalid stream data${reason}`,
      retryable: true,
    },
  };
}

export interface OpenAICompatibleProviderOptions {
  provider: Exclude<ProviderId, 'openai'>;
  apiKey: string;
  baseURL: string;
}

/** Adapter for vendors exposing the OpenAI Chat Completions compatibility API. */
export class OpenAICompatibleProvider implements AgentProvider {
  public readonly name: string;
  public readonly supportsResponseContinuation = false;
  private readonly endpoint: string;

  public constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.name = options.provider;
    this.endpoint = `${options.baseURL.replace(/\/+$/u, '')}/chat/completions`;
  }

  public async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: messages(request.input, request.instructions),
          ...deepSeekGenerationOptions(request),
          ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
          ...(request.tools === undefined ? {} : { tools: tools(request.tools) }),
          ...(request.tools === undefined ? {} : { parallel_tool_calls: true }),
          stream: true,
          stream_options: { include_usage: true },
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield {
        type: 'error',
        error: { code: 'PROVIDER_CONNECTION_ERROR', message, retryable: true },
      };
      return;
    }
    if (!response.ok) {
      yield providerError(response.status, await response.text());
      return;
    }

    let responseId: string | undefined;
    let finishReason: string | undefined;
    let outputText = '';
    const toolCalls = new Map<number, CollectedToolCall>();
    const processResponse = function* (payload: ChatResponse): Iterable<ProviderEvent> {
      responseId = payload.id ?? responseId;
      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      const reasoning = delta?.reasoning_content ?? choice?.message?.reasoning_content;
      if (reasoning !== undefined && reasoning !== null) {
        yield { type: 'reasoning_delta', delta: reasoning };
      }
      const content = delta?.content ?? choice?.message?.content;
      if (content !== undefined && content !== null) {
        outputText += content;
        yield { type: 'text_delta', delta: content };
      }
      appendToolCalls(toolCalls, delta?.tool_calls ?? choice?.message?.tool_calls);
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
      }
      const mappedUsage = usage(payload);
      if (mappedUsage !== undefined) yield mappedUsage;
    };

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && response.body !== null) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawDone = false;
      try {
        for (;;) {
          const read = await reader.read();
          if (read.done) break;
          buffer += decoder.decode(read.value as Uint8Array, { stream: true });
          const split = splitSseFrames(buffer);
          buffer = split.remainder;
          for (const frame of split.frames) {
            const data = ssePayload(frame);
            if (data === undefined) continue; // comments, including : keep-alive
            if (data === '[DONE]') {
              sawDone = true;
              continue;
            }
            try {
              const payload = JSON.parse(data) as ChatResponse;
              const upstreamError = streamError(payload);
              if (upstreamError !== undefined) {
                yield upstreamError;
                return;
              }
              for (const event of processResponse(payload)) yield event;
            } catch (error) {
              yield invalidStreamError(error);
              return;
            }
          }
        }
        // Flush a UTF-8 code point split across the final network chunk.
        buffer += decoder.decode();
        const data = ssePayload(buffer);
        if (data === '[DONE]') sawDone = true;
        else if (data !== undefined) {
          try {
            const payload = JSON.parse(data) as ChatResponse;
            const upstreamError = streamError(payload);
            if (upstreamError !== undefined) {
              yield upstreamError;
              return;
            }
            for (const event of processResponse(payload)) yield event;
          } catch (error) {
            yield invalidStreamError(error);
            return;
          }
        }
      } catch (error) {
        // A dropped socket used to escape the generator and terminate the
        // entire agent run. Surface it as retryable so AgentRunner can replay
        // the same turn without losing the session.
        const message = error instanceof Error ? error.message : String(error);
        yield {
          type: 'error',
          error: { code: 'PROVIDER_STREAM_CONNECTION_ERROR', message, retryable: true },
        };
        return;
      } finally {
        reader.releaseLock();
      }
      if (this.options.provider === 'deepseek' && !sawDone) {
        // DeepSeek documents [DONE] as the stream terminator. EOF without it
        // means the response is truncated and must not be reported as a
        // successful completed turn.
        yield {
          type: 'error',
          error: {
            code: 'PROVIDER_STREAM_TRUNCATED',
            message: 'DeepSeek stream ended before the [DONE] marker.',
            retryable: true,
          },
        };
        return;
      }
    } else if (contentType.includes('text/event-stream')) {
      yield {
        type: 'error',
        error: {
          code: 'PROVIDER_STREAM_INVALID',
          message: 'Provider returned an empty streaming response body.',
          retryable: true,
        },
      };
      return;
    } else {
      try {
        for (const event of processResponse((await response.json()) as ChatResponse)) yield event;
      } catch {
        yield {
          type: 'error',
          error: {
            code: 'PROVIDER_RESPONSE_INVALID',
            message: 'Provider returned an invalid response.',
            retryable: true,
          },
        };
        return;
      }
    }

    for (const call of toolCalls.values()) {
      if (call.name.length === 0) continue;
      const event: ProviderToolCall = {
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      };
      yield { type: 'tool_call', call: event };
    }
    yield {
      type: 'response_completed',
      responseId: responseId ?? randomUUID(),
      outputText,
      finishReason:
        finishReason === 'stop' || finishReason === undefined ? 'completed' : finishReason,
    };
  }

  public async checkConnection(signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.options.baseURL.replace(/\/+$/u, '')}/models`, {
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${String(response.status)}`);
  }
}
