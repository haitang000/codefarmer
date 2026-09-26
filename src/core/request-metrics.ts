import type { ProviderRequest, TokenUsage } from '../types.js';

/**
 * Character counts are a provider-independent proxy for prompt size. They are
 * diagnostics only; actual token usage always comes from the provider.
 */
export function measureRequestPayload(
  request: Pick<ProviderRequest, 'instructions' | 'input' | 'tools'>,
): TokenUsage {
  const input = request.input;
  const serializedInput = typeof input === 'string' ? input : JSON.stringify(input);
  const toolOutputChars =
    typeof input === 'string'
      ? 0
      : input.reduce(
          (total, item) =>
            item.type === 'function_call_output' ? total + item.output.length : total,
          0,
        );
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 1,
    instructionChars: request.instructions?.length ?? 0,
    toolSchemaChars: JSON.stringify(request.tools ?? []).length,
    inputChars: serializedInput.length,
    toolOutputChars,
  };
}
