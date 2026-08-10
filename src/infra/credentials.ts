import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { getAppPaths } from './paths.js';
import type { AppPaths } from './paths.js';
import { readJsonFileIfExists, writeJsonAtomic } from './persistence.js';
import type { ProviderId } from '../types.js';

const credentialsSchema = z.object({
  openaiApiKey: z.string().min(1).optional(),
  geminiApiKey: z.string().min(1).optional(),
  grokApiKey: z.string().min(1).optional(),
  deepseekApiKey: z.string().min(1).optional(),
  kimiApiKey: z.string().min(1).optional(),
});

type CredentialsFile = z.infer<typeof credentialsSchema>;

type CredentialsPaths = Pick<AppPaths, 'config'>;

export function getCredentialsPath(appPaths: CredentialsPaths = getAppPaths()): string {
  return path.join(appPaths.config, 'credentials.json');
}

export async function readStoredApiKey(appPaths?: CredentialsPaths): Promise<string | undefined> {
  return readStoredProviderApiKey('openai', appPaths);
}

function credentialField(provider: ProviderId): keyof CredentialsFile {
  return `${provider}ApiKey`;
}

export async function readStoredProviderApiKey(
  provider: ProviderId,
  appPaths?: CredentialsPaths,
): Promise<string | undefined> {
  try {
    const stored = await readJsonFileIfExists(getCredentialsPath(appPaths), credentialsSchema);
    return stored?.[credentialField(provider)];
  } catch {
    return undefined;
  }
}

export async function saveApiKey(apiKey: string, appPaths?: CredentialsPaths): Promise<string> {
  return saveProviderApiKey('openai', apiKey, appPaths);
}

export async function saveProviderApiKey(
  provider: ProviderId,
  apiKey: string,
  appPaths?: CredentialsPaths,
): Promise<string> {
  const trimmed = apiKey.trim();
  const credentialsPath = getCredentialsPath(appPaths);
  const existing = (await readJsonFileIfExists(credentialsPath, credentialsSchema)) ?? {};
  await writeJsonAtomic(
    credentialsPath,
    { ...existing, [credentialField(provider)]: trimmed },
    { mode: 0o600 },
  );
  return credentialsPath;
}

export async function deleteStoredApiKey(appPaths?: CredentialsPaths): Promise<void> {
  await rm(getCredentialsPath(appPaths), { force: true });
}

/**
 * 环境变量优先，其次读取本地凭据文件。
 */
export async function resolveApiKey(appPaths?: CredentialsPaths): Promise<string | undefined> {
  return resolveProviderApiKey('openai', appPaths);
}

export async function resolveProviderApiKey(
  provider: ProviderId,
  appPaths?: CredentialsPaths,
): Promise<string | undefined> {
  const environmentNames: Record<ProviderId, readonly string[]> = {
    openai: ['OPENAI_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    grok: ['XAI_API_KEY', 'GROK_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
    kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  };
  for (const name of environmentNames[provider]) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value;
  }
  return readStoredProviderApiKey(provider, appPaths);
}
