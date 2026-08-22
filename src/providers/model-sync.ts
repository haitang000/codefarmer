import { createHash } from 'node:crypto';
import path from 'node:path';

import { getAppPaths } from '../infra/paths.js';
import { readJsonFileIfExists, writeJsonAtomic } from '../infra/persistence.js';
import type { CustomEndpoint } from '../types.js';
import { modelsForProvider } from './catalog.js';

export const MODEL_SYNC_TIMEOUT_MS = 8_000;
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
export const MAX_SYNCED_MODELS = 80;

export type ModelListSource = 'live' | 'cache' | 'catalog';

export interface ModelCacheRecord {
  version: 1;
  provider: string;
  baseURL: string;
  fetchedAt: string;
  models: string[];
}

export interface SyncProviderModelsOptions {
  provider: string;
  baseURL: string;
  apiKey: string;
  currentModel: string;
  customEndpoints?: readonly CustomEndpoint[];
  cacheDirectory?: string;
  now?: number;
  force?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SyncedProviderModels {
  models: string[];
  source: ModelListSource;
  fetchedAt?: string;
}

const memoryCache = new Map<string, ModelCacheRecord>();

export function resetModelSyncCacheForTests(): void {
  memoryCache.clear();
}

function cacheKey(provider: string, baseURL: string): string {
  return `${provider}\0${baseURL}`;
}

function cacheFileName(provider: string, baseURL: string): string {
  const digest = createHash('sha256')
    .update(cacheKey(provider, baseURL))
    .digest('hex')
    .slice(0, 16);
  return `${digest}.json`;
}

function isFresh(record: ModelCacheRecord, now: number): boolean {
  const fetched = Date.parse(record.fetchedAt);
  return Number.isFinite(fetched) && now - fetched < MODEL_CACHE_TTL_MS;
}

/**
 * Drop embeddings, audio, image, and other non-chat ids that OpenAI-style
 * `/models` listings mix in with conversational models.
 */
export function isLikelyChatModel(id: string): boolean {
  const name = id.trim().toLowerCase();
  if (name.length === 0 || name.length > 128) return false;
  if (name.includes('\0')) return false;
  return !(
    name.includes('embedding') ||
    name.includes('moderation') ||
    name.includes('whisper') ||
    name.includes('transcribe') ||
    name.includes('tts') ||
    name.includes('dall-e') ||
    name.includes('dalle') ||
    name.includes('gpt-image') ||
    name.includes('sora-') ||
    name.startsWith('babbage') ||
    name.startsWith('davinci') ||
    name.startsWith('canary') ||
    name.includes('realtime') ||
    name.includes('audio-preview')
  );
}

export function parseModelListPayload(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const raw = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(payload)
        ? payload
        : [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && isLikelyChatModel(entry)) {
      ids.push(entry.trim());
      continue;
    }
    if (entry !== null && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && isLikelyChatModel(id)) ids.push(id.trim());
    }
  }
  return [...new Set(ids)].slice(0, MAX_SYNCED_MODELS);
}

export function mergeModelLists(
  curated: readonly string[],
  fetched: readonly string[],
  currentModel: string,
): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  const add = (value: string): void => {
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    models.push(value);
  };
  for (const model of curated) add(model);
  const extras = fetched
    .filter((model) => !seen.has(model))
    .sort((left, right) => left.localeCompare(right));
  for (const model of extras) add(model);
  if (currentModel.length > 0) add(currentModel);
  return models;
}

export async function fetchCompatibleModels(options: {
  baseURL: string;
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/models`;
  const timeout = AbortSignal.timeout(MODEL_SYNC_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Model list returned HTTP ${String(response.status)}`);
  }
  return parseModelListPayload(await response.json());
}

async function readDiskCache(
  directory: string,
  provider: string,
  baseURL: string,
): Promise<ModelCacheRecord | undefined> {
  const filePath = path.join(directory, cacheFileName(provider, baseURL));
  const record = await readJsonFileIfExists<ModelCacheRecord>(filePath);
  if (record?.version !== 1 || !Array.isArray(record.models)) return undefined;
  if (record.provider !== provider || record.baseURL !== baseURL) return undefined;
  return record;
}

async function writeDiskCache(directory: string, record: ModelCacheRecord): Promise<void> {
  const filePath = path.join(directory, cacheFileName(record.provider, record.baseURL));
  await writeJsonAtomic(filePath, record);
}

/**
 * Refresh the `/model` picker list from the provider's OpenAI-compatible
 * `/models` endpoint. Falls back to a disk/memory cache, then the curated
 * catalog, so a network failure never empties the picker.
 */
export async function syncProviderModels(
  options: SyncProviderModelsOptions,
): Promise<SyncedProviderModels> {
  const now = options.now ?? Date.now();
  const cacheDirectory = options.cacheDirectory ?? path.join(getAppPaths().cache, 'models');
  const curated = modelsForProvider(
    options.provider,
    options.customEndpoints,
    options.currentModel,
  );
  const key = cacheKey(options.provider, options.baseURL);

  const remember = async (
    models: string[],
    source: ModelListSource,
    fetchedAt: string,
  ): Promise<SyncedProviderModels> => {
    const record: ModelCacheRecord = {
      version: 1,
      provider: options.provider,
      baseURL: options.baseURL,
      fetchedAt,
      models,
    };
    memoryCache.set(key, record);
    if (source === 'live') {
      try {
        await writeDiskCache(cacheDirectory, record);
      } catch {
        // Cache writes are an optimisation.
      }
    }
    return {
      models: mergeModelLists(curated, models, options.currentModel),
      source,
      fetchedAt,
    };
  };

  if (options.force !== true) {
    const memory = memoryCache.get(key);
    if (memory !== undefined && isFresh(memory, now)) {
      return {
        models: mergeModelLists(curated, memory.models, options.currentModel),
        source: 'cache',
        fetchedAt: memory.fetchedAt,
      };
    }
    try {
      const disk = await readDiskCache(cacheDirectory, options.provider, options.baseURL);
      if (disk !== undefined && isFresh(disk, now)) {
        memoryCache.set(key, disk);
        return {
          models: mergeModelLists(curated, disk.models, options.currentModel),
          source: 'cache',
          fetchedAt: disk.fetchedAt,
        };
      }
    } catch {
      // Ignore a corrupt cache file and try the network.
    }
  }

  try {
    const fetched = await fetchCompatibleModels({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    return await remember(fetched, 'live', new Date(now).toISOString());
  } catch {
    const stale = memoryCache.get(key);
    if (stale !== undefined) {
      return {
        models: mergeModelLists(curated, stale.models, options.currentModel),
        source: 'cache',
        fetchedAt: stale.fetchedAt,
      };
    }
    try {
      const disk = await readDiskCache(cacheDirectory, options.provider, options.baseURL);
      if (disk !== undefined) {
        memoryCache.set(key, disk);
        return {
          models: mergeModelLists(curated, disk.models, options.currentModel),
          source: 'cache',
          fetchedAt: disk.fetchedAt,
        };
      }
    } catch {
      // Fall through to the catalog.
    }
    return { models: curated, source: 'catalog' };
  }
}
