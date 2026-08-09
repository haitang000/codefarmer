import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeJsonAtomic } from '../src/infra/persistence.js';
import type * as CredentialsModule from '../src/infra/credentials.js';

let root: string;
// env-paths 在模块加载时缓存 os.homedir()（macOS/Windows 分支），静态 import
// 会让它读到真实用户目录，vi.stubEnv('HOME') 失效。改为 stub 后动态加载。
let credentials: typeof CredentialsModule;

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
  vi.resetModules();
  credentials = await import('../src/infra/credentials.js');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('local credential store', () => {
  it('saves and reads back the API key outside the workspace', async () => {
    const savedPath = await credentials.saveApiKey(' sk-test-123 ');

    expect(savedPath).toBe(credentials.getCredentialsPath());
    expect(savedPath).not.toContain('codefarmer.config.json');
    expect(await credentials.readStoredApiKey()).toBe('sk-test-123');
  });

  it('prefers the environment variable over the stored key', async () => {
    await credentials.saveApiKey('stored-key');
    vi.stubEnv('OPENAI_API_KEY', 'env-key');

    expect(await credentials.resolveApiKey()).toBe('env-key');
  });

  it('falls back to the stored key when the environment variable is missing', async () => {
    await credentials.saveApiKey('stored-key');
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await credentials.resolveApiKey()).toBe('stored-key');
  });

  it('returns undefined when no credential file exists', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await credentials.readStoredApiKey()).toBeUndefined();
    expect(await credentials.resolveApiKey()).toBeUndefined();
  });

  it('ignores a corrupt credential file instead of throwing', async () => {
    await writeJsonAtomic(credentials.getCredentialsPath(), { openaiApiKey: 42 });
    vi.stubEnv('OPENAI_API_KEY', '');

    expect(await credentials.readStoredApiKey()).toBeUndefined();
  });

  it('deletes the stored key', async () => {
    await credentials.saveApiKey('stored-key');
    await credentials.deleteStoredApiKey();

    expect(await credentials.readStoredApiKey()).toBeUndefined();
  });
});
