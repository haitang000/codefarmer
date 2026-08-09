import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import envPaths from 'env-paths';

export interface AppPaths {
  data: string;
  config: string;
  cache: string;
  log: string;
  temp: string;
  userConfigFile: string;
  sessions: string;
  transactions: string;
}

export interface WorkspacePaths {
  workspace: string;
  hash: string;
  sessions: string;
  transactions: string;
}

export function getAppPaths(): AppPaths {
  const paths = envPaths('codefarmer', { suffix: '' });
  return {
    ...paths,
    userConfigFile: path.join(paths.config, 'codefarmer.config.json'),
    sessions: path.join(paths.data, 'sessions'),
    transactions: path.join(paths.data, 'transactions'),
  };
}

export async function ensureAppDirectories(paths = getAppPaths()): Promise<void> {
  await Promise.all([
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.config, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
    mkdir(paths.log, { recursive: true }),
    mkdir(paths.temp, { recursive: true }),
    mkdir(paths.sessions, { recursive: true }),
    mkdir(paths.transactions, { recursive: true }),
  ]);
}

export async function canonicalWorkspace(workspace: string): Promise<string> {
  return realpath(path.resolve(workspace));
}

export function workspaceHash(workspace: string): string {
  const normalized = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

export async function getWorkspacePaths(
  workspace: string,
  appPaths = getAppPaths(),
): Promise<WorkspacePaths> {
  const canonical = await canonicalWorkspace(workspace);
  const hash = workspaceHash(canonical);
  return {
    workspace: canonical,
    hash,
    sessions: path.join(appPaths.sessions, hash),
    transactions: path.join(appPaths.transactions, hash),
  };
}

export async function ensureWorkspaceDirectories(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.sessions, { recursive: true }),
    mkdir(paths.transactions, { recursive: true }),
  ]);
}
