import type { ProviderId } from '../types.js';

export interface ProviderPreset {
  id: ProviderId;
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
};

export function providerPreset(provider: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS[provider];
}

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_PRESETS, value);
}
