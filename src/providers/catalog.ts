import type { CustomEndpoint, ProviderId } from '../types.js';

export interface ProviderPreset {
  id: string;
  label: string;
  defaultModel: string;
  defaultBaseURL: string;
  environmentVariables: readonly string[];
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-5.6-sol',
    defaultBaseURL: 'https://api.openai.com/v1',
    environmentVariables: ['OPENAI_API_KEY'],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-pro',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    environmentVariables: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  grok: {
    id: 'grok',
    label: 'xAI Grok',
    defaultModel: 'grok-4',
    defaultBaseURL: 'https://api.x.ai/v1',
    environmentVariables: ['XAI_API_KEY', 'GROK_API_KEY'],
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    defaultBaseURL: 'https://api.deepseek.com',
    environmentVariables: ['DEEPSEEK_API_KEY'],
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    defaultModel: 'kimi-k2-0711-preview',
    defaultBaseURL: 'https://api.moonshot.cn/v1',
    environmentVariables: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  },
  'opencode-go': {
    id: 'opencode-go',
    label: 'OpenCode Go',
    defaultModel: 'qwen3.7-plus',
    defaultBaseURL: 'https://opencode.ai/zen/go/v1',
    environmentVariables: ['OPENCODE_API_KEY'],
  },
};

/**
 * Well-known models offered by the `/model` picker for each built-in
 * provider, in recommendation order (flagship first). Curated from the same
 * model universe as the price table in `core/stats.ts`; the current session
 * model is always added on top even when it is not on the list, so switching
 * back stays possible for ad-hoc names.
 */
export const PROVIDER_MODELS: Record<ProviderId, readonly string[]> = {
  openai: [
    'gpt-5.6-sol',
    'gpt-5-pro',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'o4-mini',
    'o3',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
  ],
  gemini: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ],
  grok: ['grok-4', 'grok-4.5', 'grok-3', 'grok-2'],
  deepseek: [
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-coder',
  ],
  kimi: ['kimi-k2-0711-preview', 'kimi-k2.5', 'kimi-k2'],
  'opencode-go': ['qwen3.7-plus'],
};

/**
 * Models the `/model` picker should offer for a provider: the curated list
 * for built-in providers, the endpoint's configured model for custom
 * endpoints, and always the currently active model (deduplicated, last).
 * Unknown providers degrade to a single-entry list with the current model so
 * the picker still works as a read-only status view.
 */
export function modelsForProvider(
  provider: string,
  customEndpoints: readonly CustomEndpoint[] | undefined,
  currentModel: string,
): string[] {
  const models: string[] = isProviderId(provider) ? [...PROVIDER_MODELS[provider]] : [];
  const endpoint = findCustomEndpoint(provider, customEndpoints);
  if (endpoint !== undefined && endpoint.model.length > 0 && !models.includes(endpoint.model)) {
    models.push(endpoint.model);
  }
  if (models.length === 0) return currentModel.length === 0 ? [] : [currentModel];
  if (currentModel.length > 0 && !models.includes(currentModel)) models.push(currentModel);
  return models;
}

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_PRESETS, value);
}

/** Look up a user-defined endpoint by id. */
export function findCustomEndpoint(
  id: string,
  endpoints: readonly CustomEndpoint[] | undefined,
): CustomEndpoint | undefined {
  return endpoints?.find((endpoint) => endpoint.id === id);
}

/**
 * Resolve the preset for a provider. Built-in providers use the catalog;
 * custom endpoints are turned into presets backed by their config entry.
 * Unknown ids degrade to a generic preset so status/doctor output can still
 * render; configuration validation rejects unknown providers earlier.
 */
export function providerPreset(
  provider: string,
  customEndpoints?: readonly CustomEndpoint[],
): ProviderPreset {
  if (isProviderId(provider)) return PROVIDER_PRESETS[provider];
  const endpoint = findCustomEndpoint(provider, customEndpoints);
  if (endpoint !== undefined) {
    return {
      id: endpoint.id,
      label: endpoint.label ?? endpoint.id,
      defaultModel: endpoint.model,
      defaultBaseURL: endpoint.baseURL,
      environmentVariables:
        endpoint.apiKeyEnv === undefined ? ['CODEFARMER_API_KEY'] : [endpoint.apiKeyEnv],
    };
  }
  return {
    id: provider,
    label: provider,
    defaultModel: '',
    defaultBaseURL: '',
    environmentVariables: [],
  };
}
