import { describe, expect, it } from 'vitest';

import { mergeSetupConfig, type SetupConfigSelection } from '../src/cli/commands.js';
import type { ConfigFile } from '../src/infra/config.js';
import type { CustomEndpoint } from '../src/types.js';

const deepseekSelection: SetupConfigSelection = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  baseURL: 'https://api.deepseek.com',
  reasoning: 'high',
  verbosity: 'low',
  reasoningSummary: 'none',
  approval: 'ask',
};

const ollamaEndpoint: CustomEndpoint = {
  id: 'ollama',
  label: 'Local Ollama',
  baseURL: 'http://localhost:11434/v1',
  model: 'llama3.2',
  apiKeyOptional: true,
};

describe('mergeSetupConfig', () => {
  it('preserves saved custom endpoints and unrelated settings when switching to a built-in provider', () => {
    const current: ConfigFile = {
      provider: 'ollama',
      model: 'llama3.2',
      baseURL: 'http://localhost:11434/v1',
      language: 'zh-CN',
      customEndpoints: [ollamaEndpoint],
    };

    const merged = mergeSetupConfig(current, deepseekSelection, undefined);

    expect(merged.provider).toBe('deepseek');
    expect(merged.model).toBe('deepseek-v4-flash');
    expect(merged.baseURL).toBe('https://api.deepseek.com');
    expect(merged.language).toBe('zh-CN');
    expect(merged.customEndpoints).toEqual([ollamaEndpoint]);
  });

  it('adds a newly configured custom endpoint alongside previously saved ones', () => {
    const current: ConfigFile = { customEndpoints: [ollamaEndpoint] };
    const vllmEndpoint: CustomEndpoint = {
      id: 'vllm',
      label: 'Local vLLM',
      baseURL: 'http://localhost:8000/v1',
      model: 'qwen2.5',
    };

    const merged = mergeSetupConfig(
      current,
      {
        ...deepseekSelection,
        provider: 'vllm',
        baseURL: vllmEndpoint.baseURL,
        model: vllmEndpoint.model,
      },
      vllmEndpoint,
    );

    expect(merged.provider).toBe('vllm');
    expect(merged.customEndpoints).toEqual([ollamaEndpoint, vllmEndpoint]);
  });

  it('upserts the selected custom endpoint instead of duplicating it', () => {
    const current: ConfigFile = { customEndpoints: [ollamaEndpoint] };
    const updated: CustomEndpoint = { ...ollamaEndpoint, model: 'llama3.3' };

    const merged = mergeSetupConfig(
      current,
      {
        ...deepseekSelection,
        provider: 'ollama',
        baseURL: updated.baseURL,
        model: updated.model,
      },
      updated,
    );

    expect(merged.provider).toBe('ollama');
    expect(merged.customEndpoints).toEqual([updated]);
  });

  it('produces a complete config when no file exists yet', () => {
    const merged = mergeSetupConfig(undefined, deepseekSelection, undefined);

    expect(merged).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseURL: 'https://api.deepseek.com',
      reasoning: 'high',
      verbosity: 'low',
      reasoningSummary: 'none',
      approval: 'ask',
    });
    expect(merged.$schema).toMatch(/codefarmer/);
  });
});
