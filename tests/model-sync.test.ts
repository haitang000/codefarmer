import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isLikelyChatModel,
  mergeModelLists,
  parseModelListPayload,
  resetModelSyncCacheForTests,
  syncProviderModels,
} from '../src/providers/model-sync.js';

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetModelSyncCacheForTests();
  await Promise.all([
    ...temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  ]);
});

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}/v1`;
}

describe('model list parsing', () => {
  it('keeps chat models and drops embeddings, audio, and image ids', () => {
    expect(isLikelyChatModel('gpt-5.6-sol')).toBe(true);
    expect(isLikelyChatModel('deepseek-chat')).toBe(true);
    expect(isLikelyChatModel('text-embedding-3-small')).toBe(false);
    expect(isLikelyChatModel('whisper-1')).toBe(false);
    expect(isLikelyChatModel('tts-1')).toBe(false);
    expect(isLikelyChatModel('dall-e-3')).toBe(false);
    expect(
      parseModelListPayload({
        data: [
          { id: 'gpt-5.6-sol' },
          { id: 'text-embedding-3-large' },
          { id: 'gpt-4.1-mini' },
          'whisper-1',
        ],
      }),
    ).toEqual(['gpt-5.6-sol', 'gpt-4.1-mini']);
  });

  it('merges curated models first, then new upstream ids, then the current model', () => {
    expect(mergeModelLists(['flagship', 'mini'], ['zeta', 'mini', 'alpha'], 'current')).toEqual([
      'flagship',
      'mini',
      'alpha',
      'zeta',
      'current',
    ]);
  });
});

describe('syncProviderModels', () => {
  it('fetches /models, caches the result, and falls back when the endpoint fails', async () => {
    const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'codefarmer-models-'));
    temporaryDirectories.push(cacheDirectory);
    let hits = 0;
    const baseURL = await startServer((request, response) => {
      hits += 1;
      if (request.url !== '/v1/models') {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'upstream-new' }, { id: 'gpt-5.6-sol' }] }));
    });

    const live = await syncProviderModels({
      provider: 'openai',
      baseURL,
      apiKey: 'test',
      currentModel: 'gpt-5.6-sol',
      cacheDirectory,
    });
    expect(live.source).toBe('live');
    expect(live.models).toContain('upstream-new');
    expect(live.models[0]).toBe('gpt-5.6-sol');
    expect(hits).toBe(1);

    const cached = await syncProviderModels({
      provider: 'openai',
      baseURL,
      apiKey: 'test',
      currentModel: 'gpt-5.6-sol',
      cacheDirectory,
    });
    expect(cached.source).toBe('cache');
    expect(cached.models).toContain('upstream-new');
    expect(hits).toBe(1);

    const failedBase = await startServer((_request, response) => {
      response.statusCode = 503;
      response.end('busy');
    });
    const fallback = await syncProviderModels({
      provider: 'openai',
      baseURL: failedBase,
      apiKey: 'test',
      currentModel: 'ad-hoc',
      cacheDirectory,
      force: true,
    });
    expect(fallback.source).toBe('catalog');
    expect(fallback.models).toContain('gpt-5.6-sol');
    expect(fallback.models).toContain('ad-hoc');
  });
});
