import { describe, expect, it } from 'vitest';

import { resolveSessionConfig } from '../src/cli/runtime.js';
import { DEFAULT_CONFIG } from '../src/infra/config.js';
import { ConfigError } from '../src/infra/errors.js';
import type { SessionRecord } from '../src/types.js';

function session(baseURL?: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: 'session-1',
    workspace: '/workspace',
    provider: 'openai',
    model: 'session-model',
    ...(baseURL === undefined ? {} : { baseURL }),
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    messages: [],
    toolCalls: [],
  };
}

describe('session runtime configuration', () => {
  it('keeps the endpoint and model used to create a resumed session', () => {
    const resolved = resolveSessionConfig(
      { ...DEFAULT_CONFIG, model: 'new-default', baseURL: 'https://new.example/v1' },
      {},
      session('https://session.example/v1'),
      true,
    );

    expect(resolved.model).toBe('session-model');
    expect(resolved.baseURL).toBe('https://session.example/v1');
  });

  it('rejects an explicit endpoint change while resuming', () => {
    expect(() =>
      resolveSessionConfig(
        { ...DEFAULT_CONFIG, baseURL: 'https://other.example/v1' },
        { baseURL: 'https://other.example/v1' },
        session('https://session.example/v1'),
        true,
      ),
    ).toThrow(ConfigError);
  });

  it('allows a new session to use the requested endpoint', () => {
    const requested = { ...DEFAULT_CONFIG, baseURL: 'http://localhost:8080/v1' };
    expect(resolveSessionConfig(requested, { baseURL: requested.baseURL }, undefined, false)).toBe(
      requested,
    );
  });
});
