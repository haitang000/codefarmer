import OpenAI from 'openai';
import type { ResponseInput, Tool } from 'openai/resources/responses/responses';

import type {
  AgentProvider,
  ProviderEvent,
  ProviderInput,
  ProviderRequest,
  TokenUsage,
} from '../types.js';

function mapInput(input: string | ProviderInput[]): string | ResponseInput {
  if (typeof input === 'string') return input;
  return input.map((item) => {
    if (item.type === 'function_call_output') {
      return {
        type: 'function_call_output' as const,
        call_id: item.callId,
        output: item.output,
      };
    }
    if (item.type === 'function_call') {
      return {
        type: 'function_call' as const,
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
      };
    }
    return { role: item.role, content: item.content, type: 'message' as const };
  });
}

function mapTools(request: ProviderRequest): Tool[] | undefined {
  return request.tools?.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  }));
}

function mapUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: usage.output_tokens_details.reasoning_tokens }),
    ...(usage.input_tokens_details?.cached_tokens === undefined
      ? {}
      : { cachedInputTokens: usage.input_tokens_details.cached_tokens }),
  };
}

function providerError(error: unknown): ProviderEvent {
  if (error instanceof OpenAI.APIConnectionError) {
    // Dropped sockets, DNS hiccups, and timeouts surface as connection
    // errors; the agent loop should retry these instead of dying mid-task.
    return {
      type: 'error',
      error: {
        code: error.code ?? 'OPENAI_CONNECTION_ERROR',
        message: error.message,
        retryable: true,
      },
    };
  }
  if (error instanceof OpenAI.APIError) {
    return {
      type: 'error',
      error: {
        code: error.code ?? `OPENAI_HTTP_${String(error.status)}`,
        message: error.message,
        retryable:
          error.status === 408 ||
          error.status === 409 ||
          error.status === 429 ||
          error.status >= 500,
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'error', error: { code: 'OPENAI_REQUEST_FAILED', message, retryable: false } };
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  maxRetries?: number;
  connectionModel?: string;
}

export class OpenAIProvider implements AgentProvider {
  public readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly connectionModel: string;

  public constructor(options: OpenAIProviderOptions = {}) {
    this.connectionModel = options.connectionModel ?? 'gpt-5.6-sol';
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      maxRetries: options.maxRetries ?? 2,
      // Long reasoning runs can exceed the SDK default 10-minute timeout;
      // give the model ample time instead of aborting mid-task.
      timeout: 30 * 60 * 1000,
    });
  }

  public async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    try {
      const reasoningSummary = request.reasoningSummary ?? 'auto';
      const reasoning =
        request.reasoning === 'auto' && reasoningSummary === 'none'
          ? undefined
          : {
              ...(request.reasoning === 'auto' ? {} : { effort: request.reasoning }),
              ...(reasoningSummary === 'none' ? {} : { summary: reasoningSummary }),
            };
      const stream = await this.client.responses.create(
        {
          model: request.model,
          input: mapInput(request.input),
          ...(reasoning === undefined ? {} : { reasoning }),
          text: { verbosity: request.verbosity ?? 'medium' },
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
          ...(request.previousResponseId === undefined
            ? {}
            : { previous_response_id: request.previousResponseId }),
          ...(request.tools === undefined ? {} : { tools: mapTools(request) ?? [] }),
          parallel_tool_calls: true,
          store: request.store ?? true,
          stream: true,
        },
        request.signal === undefined ? undefined : { signal: request.signal },
      );

      let summaryPartsSeen = false;
      for await (const event of stream) {
        if (event.type === 'response.reasoning_summary_part.added') {
          // 多段推理摘要之间补一个空行分隔，保持思考过程可读。
          if (summaryPartsSeen) yield { type: 'reasoning_delta', delta: '\n\n' };
          summaryPartsSeen = true;
          continue;
        }

        if (event.type === 'response.reasoning_summary_text.delta') {
          yield { type: 'reasoning_delta', delta: event.delta };
          continue;
        }

        if (event.type === 'response.output_text.delta') {
          yield { type: 'text_delta', delta: event.delta };
          continue;
        }

        if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
          yield {
            type: 'tool_call',
            call: {
              callId: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments,
            },
          };
          continue;
        }

        if (event.type === 'response.completed') {
          if (event.response.usage !== undefined) {
            yield { type: 'usage', usage: mapUsage(event.response.usage) };
          }
          yield {
            type: 'response_completed',
            responseId: event.response.id,
            outputText: event.response.output_text,
            finishReason: event.response.status ?? 'completed',
          };
          continue;
        }

        if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          const error = event.response.error;
          const incompleteReason = event.response.incomplete_details?.reason;
          if (event.type === 'response.incomplete' && incompleteReason !== 'content_filter') {
            // A truncated response (typically max_output_tokens) is a partial
            // completion, not a hard failure: report it as completed with a
            // warning so the agent keeps going with the tool calls and text it
            // already produced, instead of retrying the same request (which
            // truncates again) and then dying mid-task.
            if (event.response.usage !== undefined) {
              yield { type: 'usage', usage: mapUsage(event.response.usage) };
            }
            yield {
              type: 'response_completed',
              responseId: event.response.id,
              outputText: event.response.output_text,
              finishReason: event.response.status ?? 'incomplete',
            };
            continue;
          }
          yield {
            type: 'error',
            error: {
              code:
                error?.code ??
                (event.type === 'response.incomplete'
                  ? 'OPENAI_RESPONSE_INCOMPLETE'
                  : 'OPENAI_RESPONSE_FAILED'),
              message:
                error?.message ??
                event.response.incomplete_details?.reason ??
                '响应未完成',
              retryable: incompleteReason === 'content_filter' ? false : true,
            },
          };
          continue;
        }

        if (event.type === 'error') {
          // SSE-level error events emitted mid-stream by gateways/proxies are
          // almost always transient (upstream 5xx, rate limits); retry them.
          yield {
            type: 'error',
            error: {
              code: event.code ?? 'OPENAI_STREAM_ERROR',
              message: event.message,
              retryable: true,
            },
          };
        }
      }
    } catch (error) {
      yield providerError(error);
    }
  }

  public async checkConnection(signal?: AbortSignal): Promise<void> {
    await this.client.models.retrieve(
      this.connectionModel,
      signal === undefined ? undefined : { signal },
    );
  }
}
