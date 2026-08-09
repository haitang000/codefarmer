import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { getAppPaths } from './paths.js';
import { readJsonFileIfExists, writeJsonAtomic } from './persistence.js';

const credentialsSchema = z.object({
  openaiApiKey: z.string().min(1),
});

type CredentialsFile = z.infer<typeof credentialsSchema>;

export function getCredentialsPath(): string {
  return path.join(getAppPaths().config, 'credentials.json');
}

export async function readStoredApiKey(): Promise<string | undefined> {
  try {
    const stored = await readJsonFileIfExists(getCredentialsPath(), credentialsSchema);
    return stored?.openaiApiKey;
  } catch {
    return undefined;
  }
}

export async function saveApiKey(apiKey: string): Promise<string> {
  const trimmed = apiKey.trim();
  const credentials: CredentialsFile = { openaiApiKey: trimmed };
  await writeJsonAtomic(getCredentialsPath(), credentials, { mode: 0o600 });
  return getCredentialsPath();
}

export async function deleteStoredApiKey(): Promise<void> {
  await rm(getCredentialsPath(), { force: true });
}

/**
 * 环境变量优先，其次读取本地凭据文件。
 */
export async function resolveApiKey(): Promise<string | undefined> {
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return readStoredApiKey();
}
