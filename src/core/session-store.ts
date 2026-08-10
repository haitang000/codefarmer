import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { getWorkspacePaths, ensureWorkspaceDirectories } from '../infra/paths.js';
import type { AppPaths } from '../infra/paths.js';
import { readJsonFile, writeJsonAtomic } from '../infra/persistence.js';
import type { SessionMessage, SessionRecord, SessionStatus, TokenUsage } from '../types.js';

const MAX_TITLE_LENGTH = 60;
const UNTITLED = '未命名会话';

/** Derive a short, single-line session title from the first user prompt. */
export function deriveSessionTitle(content: string): string {
  const firstLine = content.split(/\r?\n/u, 1)[0] ?? '';
  const collapsed = firstLine.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return UNTITLED;
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function sessionFile(directory: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('无效的会话 ID');
  return path.join(directory, `${id}.json`);
}

export class SessionStore {
  // Serialised background write chain; saves queued with `saveQueued` run in
  // order without blocking the agent loop, and `flush` drains the chain.
  private pendingWrites: Promise<void> = Promise.resolve();

  private constructor(
    public readonly workspace: string,
    private readonly directory: string,
  ) {}

  public static async create(workspace: string, appPaths?: AppPaths): Promise<SessionStore> {
    const paths = await getWorkspacePaths(workspace, appPaths);
    await ensureWorkspaceDirectories(paths);
    return new SessionStore(paths.workspace, paths.sessions);
  }

  public async createSession(
    provider: string,
    model: string,
    baseURL?: string,
  ): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      version: 1,
      id: randomUUID(),
      workspace: this.workspace,
      provider,
      model,
      ...(baseURL === undefined ? {} : { baseURL }),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      messages: [],
      toolCalls: [],
    };
    await this.save(session);
    return session;
  }

  public async get(id: string): Promise<SessionRecord> {
    return readJsonFile<SessionRecord>(sessionFile(this.directory, id));
  }

  public async save(session: SessionRecord): Promise<void> {
    await writeJsonAtomic(sessionFile(this.directory, session.id), {
      ...session,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Queue a save without blocking the caller. Writes execute sequentially
   * in queue order; later snapshots supersede earlier ones.
   */
  public saveQueued(session: SessionRecord): void {
    const snapshot = { ...session, updatedAt: new Date().toISOString() };
    this.pendingWrites = this.pendingWrites.then(() =>
      writeJsonAtomic(sessionFile(this.directory, snapshot.id), snapshot).catch(() => undefined),
    );
  }

  /** Wait for every queued background save to finish. */
  public async flush(): Promise<void> {
    await this.pendingWrites;
  }

  public async list(): Promise<SessionRecord[]> {
    const names = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
    const sessions = await Promise.all(
      names.map(async (name) => readJsonFile<SessionRecord>(path.join(this.directory, name))),
    );
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async delete(id: string): Promise<void> {
    await rm(sessionFile(this.directory, id), { force: true });
  }

  /** Set a custom title for an existing session. */
  public async rename(id: string, title: string): Promise<SessionRecord> {
    const trimmed = title.trim();
    if (trimmed.length === 0) throw new Error('会话标题不能为空');
    const session = await this.get(id);
    session.title = trimmed;
    session.titleSource = 'custom';
    await this.save(session);
    return session;
  }

  public async appendMessage(
    session: SessionRecord,
    role: SessionMessage['role'],
    content: string,
    responseId?: string,
  ): Promise<void> {
    session.messages.push({
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
      ...(responseId === undefined ? {} : { responseId }),
    });
    if (session.title === undefined) {
      session.title = deriveSessionTitle(content);
      session.titleSource = 'automatic';
    }
    if (responseId !== undefined) session.previousResponseId = responseId;
    await this.save(session);
  }

  public async setStatus(
    session: SessionRecord,
    status: SessionStatus,
    usage?: TokenUsage,
    error?: { code: string; message: string },
  ): Promise<void> {
    session.status = status;
    if (usage !== undefined) session.usage = usage;
    if (error !== undefined) session.error = error;
    else delete session.error;
    await this.save(session);
  }
}
