import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { getAppPaths } from './paths.js';
import type { AppPaths } from './paths.js';
import { readJsonFileIfExists, writeJsonAtomic } from './persistence.js';

const credentialsSchema = z.object({
  openaiApiKey: z.string().min(1),
});

type CredentialsFile = z.infer<typeof credentialsSchema>;

type CredentialsPaths = Pick<AppPaths, 'config'>;

export function getCredentialsPath(appPaths: CredentialsPaths = getAppPaths()): string {
  return path.join(appPaths.config, 'credentials.json');
}

export async function readStoredApiKey(appPaths?: CredentialsPaths): Promise<string | undefined> {
  try {
    const stored = await readJsonFileIfExists(getCredentialsPath(appPaths), credentialsSchema);
    return stored?.openaiApiKey;
  } catch {
    return undefined;
  }
}

export async function saveApiKey(apiKey: string, appPaths?: CredentialsPaths): Promise<string> {
  const trimmed = apiKey.trim();
  const credentials: CredentialsFile = { openaiApiKey: trimmed };
  const credentialsPath = getCredentialsPath(appPaths);
  await writeJsonAtomic(credentialsPath, credentials, { mode: 0o600 });
  return credentialsPath;
}

export async function deleteStoredApiKey(appPaths?: CredentialsPaths): Promise<void> {
  await rm(getCredentialsPath(appPaths), { force: true });
}

/**
 * 环境变量优先，其次读取本地凭据文件。
 */
export async function resolveApiKey(appPaths?: CredentialsPaths): Promise<string | undefined> {
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return readStoredApiKey(appPaths);
}
