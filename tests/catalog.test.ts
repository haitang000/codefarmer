import { describe, expect, it } from 'vitest';

import { modelsForProvider, PROVIDER_MODELS } from '../src/providers/catalog.js';

describe('provider model picker lists', () => {
  it('curates well-known models per built-in provider', () => {
    expect(PROVIDER_MODELS.openai[0]).toBe('gpt-5.6-sol');
    expect(PROVIDER_MODELS.gemini).toContain('gemini-2.5-pro');
    expect(PROVIDER_MODELS['opencode-go']).toEqual(['qwen3.7-plus']);
  });

  it('keeps the current model selectable even when it is not curated', () => {
    expect(modelsForProvider('openai', undefined, 'gpt-5.6-sol')).toEqual([
      ...PROVIDER_MODELS.openai,
    ]);
    expect(modelsForProvider('openai', undefined, 'ad-hoc-model')).toEqual([
      ...PROVIDER_MODELS.openai,
      'ad-hoc-model',
    ]);
  });

  it('includes the configured model for custom endpoints', () => {
    const endpoints = [{ id: 'acme', model: 'acme-pro', baseURL: 'https://acme.example/v1' }];
    expect(modelsForProvider('acme', endpoints, 'acme-pro')).toEqual(['acme-pro']);
    expect(modelsForProvider('acme', endpoints, 'fallback-model')).toEqual([
      'acme-pro',
      'fallback-model',
    ]);
  });

  it('degrades to the current model for unknown providers', () => {
    expect(modelsForProvider('unknown', undefined, 'some-model')).toEqual(['some-model']);
  });
});
