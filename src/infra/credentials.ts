import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { getAppPaths } from './paths.js';
import type { AppPaths } from './paths.js';
import { readJsonFileIfExists, writeJsonAtomic } from './persistence.js';
import { isProviderId } from '../providers/catalog.js';
import type { ProviderId } from '../types.js';

const credentialsSchema = z.object({
  openaiApiKey: z.string().min(1).optional(),
  geminiApiKey: z.string().min(1).optional(),
  grokApiKey: z.string().min(1).optional(),
  deepseekApiKey: z.string().min(1).optional(),
  kimiApiKey: z.string().min(1).optional(),
  /** `opencode-go` 的本地凭据字段；字段名由 credentialField 拼出。 */
  'opencode-goApiKey': z.string().min(1).optional(),
  /** API keys for user-defined custom endpoints, keyed by endpoint id. */
  customApiKeys: z.record(z.string(), z.string().min(1)).optional(),
});

type CredentialsFile = z.infer<typeof credentialsSchema>;

type CredentialsPaths = Pick<AppPaths, 'config'>;

export function getCredentialsPath(appPaths: CredentialsPaths = getAppPaths()): string {
  return path.join(appPaths.config, 'credentials.json');
}

export async function readStoredApiKey(appPaths?: CredentialsPaths): Promise<string | undefined> {
  return readStoredProviderApiKey('openai', appPaths);
}

function credentialField(provider: ProviderId): Exclude<keyof CredentialsFile, 'customApiKeys'> {
  return `${provider}ApiKey`;
}

export async function readStoredProviderApiKey(
  provider: string,
  appPaths?: CredentialsPaths,
): Promise<string | undefined> {
  try {
    const stored = await readJsonFileIfExists(getCredentialsPath(appPaths), credentialsSchema);
    if (isProviderId(provider)) return stored?.[credentialField(provider)];
    return stored?.customApiKeys?.[provider];
  } catch {
    return undefined;
  }
}

export async function saveApiKey(apiKey: string, appPaths?: CredentialsPaths): Promise<string> {
  return saveProviderApiKey('openai', apiKey, appPaths);
}

export async function saveProviderApiKey(
  provider: string,
  apiKey: string,
  appPaths?: CredentialsPaths,
): Promise<string> {
  const trimmed = apiKey.trim();
  const credentialsPath = getCredentialsPath(appPaths);
  const existing = (await readJsonFileIfExists(credentialsPath, credentialsSchema)) ?? {};
  const next = isProviderId(provider)
    ? { ...existing, [credentialField(provider)]: trimmed }
    : { ...existing, customApiKeys: { ...existing.customApiKeys, [provider]: trimmed } };
  await writeJsonAtomic(credentialsPath, next, { mode: 0o600 });
  return credentialsPath;
}

export async function deleteStoredApiKey(appPaths?: CredentialsPaths): Promise<void> {
  await rm(getCredentialsPath(appPaths), { force: true });
}

export interface ResolveProviderApiKeyOptions {
  /** Custom endpoint's `apiKeyEnv`; checked before the generic `CODEFARMER_API_KEY`. */
  apiKeyEnv?: string | undefined;
  appPaths?: CredentialsPaths | undefined;
}

/**
 * 环境变量优先，其次读取本地凭据文件。自定义端点依次检查
 * `apiKeyEnv`、`CODEFARMER_API_KEY` 与本地凭据文件。
 */
export async function resolveApiKey(appPaths?: CredentialsPaths): Promise<string | undefined> {
  return resolveProviderApiKey('openai', { appPaths });
}

export async function resolveProviderApiKey(
  provider: string,
  options: ResolveProviderApiKeyOptions = {},
): Promise<string | undefined> {
  const environmentNames: Record<ProviderId, readonly string[]> = {
    openai: ['OPENAI_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    grok: ['XAI_API_KEY', 'GROK_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
    kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    'opencode-go': ['OPENCODE_API_KEY'],
  };
  if (isProviderId(provider)) {
    for (const name of environmentNames[provider]) {
      const value = process.env[name];
      if (value && value.trim().length > 0) return value;
    }
  } else {
    const names = [options.apiKeyEnv, 'CODEFARMER_API_KEY'].filter(
      (name): name is string => name !== undefined,
    );
    for (const name of names) {
      const value = process.env[name];
      if (value && value.trim().length > 0) return value;
    }
  }
  return readStoredProviderApiKey(provider, options.appPaths);
}
