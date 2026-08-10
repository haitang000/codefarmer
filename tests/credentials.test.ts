import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteStoredApiKey,
  getCredentialsPath,
  readStoredApiKey,
  readStoredProviderApiKey,
  resolveApiKey,
  resolveProviderApiKey,
  saveApiKey,
  saveProviderApiKey,
} from '../src/infra/credentials.js';
import type { AppPaths } from '../src/infra/paths.js';
import { writeJsonAtomic } from '../src/infra/persistence.js';

let root: string;
let appPaths: Pick<AppPaths, 'config'>;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-credentials-'));
  appPaths = { config: path.join(root, 'config') };
  vi.stubEnv('OPENAI_API_KEY', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('local credential store', () => {
  it('saves and reads back the API key outside the workspace', async () => {
    const savedPath = await saveApiKey(' sk-test-123 ', appPaths);

    expect(savedPath).toBe(getCredentialsPath(appPaths));
    expect(savedPath).not.toContain('codefarmer.config.json');
    expect(await readStoredApiKey(appPaths)).toBe('sk-test-123');
  });

  it('prefers the environment variable over the stored key', async () => {
    await saveApiKey('stored-key', appPaths);
    vi.stubEnv('OPENAI_API_KEY', 'env-key');

    expect(await resolveApiKey(appPaths)).toBe('env-key');
  });

  it('falls back to the stored key when the environment variable is missing', async () => {
    await saveApiKey('stored-key', appPaths);
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await resolveApiKey(appPaths)).toBe('stored-key');
  });

  it('returns undefined when no credential file exists', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await readStoredApiKey(appPaths)).toBeUndefined();
    expect(await resolveApiKey(appPaths)).toBeUndefined();
  });

  it('ignores a corrupt credential file instead of throwing', async () => {
    await writeJsonAtomic(getCredentialsPath(appPaths), { openaiApiKey: 42 });
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await readStoredApiKey(appPaths)).toBeUndefined();
  });

  it('deletes the stored key', async () => {
    await saveApiKey('stored-key', appPaths);
    await deleteStoredApiKey(appPaths);

    expect(await readStoredApiKey(appPaths)).toBeUndefined();
  });

  it('keeps API keys isolated by provider and resolves provider-specific environment keys', async () => {
    await saveProviderApiKey('deepseek', 'deepseek-stored', appPaths);
    await saveProviderApiKey('gemini', 'gemini-stored', appPaths);
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-env');

    expect(await readStoredProviderApiKey('deepseek', appPaths)).toBe('deepseek-stored');
    expect(await readStoredProviderApiKey('gemini', appPaths)).toBe('gemini-stored');
    expect(await resolveProviderApiKey('deepseek', appPaths)).toBe('deepseek-env');
    expect(await resolveProviderApiKey('gemini', appPaths)).toBe('gemini-stored');
  });
});
