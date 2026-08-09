import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteStoredApiKey,
  getCredentialsPath,
  readStoredApiKey,
  resolveApiKey,
  saveApiKey,
} from '../src/infra/credentials.js';
import { writeJsonAtomic } from '../src/infra/persistence.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-credentials-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('APPDATA', path.join(root, 'appdata'));
  vi.stubEnv('LOCALAPPDATA', path.join(root, 'localappdata'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'xdg-config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'xdg-data'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(root, 'xdg-cache'));
  vi.stubEnv('XDG_STATE_HOME', path.join(root, 'xdg-state'));
  vi.stubEnv('OPENAI_API_KEY', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('local credential store', () => {
  it('saves and reads back the API key outside the workspace', async () => {
    const savedPath = await saveApiKey(' sk-test-123 ');

    expect(savedPath).toBe(getCredentialsPath());
    expect(savedPath).not.toContain('codefarmer.config.json');
    expect(await readStoredApiKey()).toBe('sk-test-123');
  });

  it('prefers the environment variable over the stored key', async () => {
    await saveApiKey('stored-key');
    vi.stubEnv('OPENAI_API_KEY', 'env-key');

    expect(await resolveApiKey()).toBe('env-key');
  });

  it('falls back to the stored key when the environment variable is missing', async () => {
    await saveApiKey('stored-key');
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await resolveApiKey()).toBe('stored-key');
  });

  it('returns undefined when no credential file exists', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await readStoredApiKey()).toBeUndefined();
    expect(await resolveApiKey()).toBeUndefined();
  });

  it('ignores a corrupt credential file instead of throwing', async () => {
    await writeJsonAtomic(getCredentialsPath(), { openaiApiKey: 42 });
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await readStoredApiKey()).toBeUndefined();
  });

  it('deletes the stored key', async () => {
    await saveApiKey('stored-key');
    await deleteStoredApiKey();

    expect(await readStoredApiKey()).toBeUndefined();
  });
});
