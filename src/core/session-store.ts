import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { getWorkspacePaths, ensureWorkspaceDirectories } from '../infra/paths.js';
import type { AppPaths } from '../infra/paths.js';
import { readJsonFile, writeJsonAtomic } from '../infra/persistence.js';
import type {
  SessionExecutionState,
  SessionMessage,
  SessionRecord,
  SessionStatus,
  TokenUsage,
} from '../types.js';

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

function shouldDeferSession(session: SessionRecord): boolean {
  return (
    session.messages.length === 0 &&
    (session.execution?.queuedTurns.length ?? 0) === 0 &&
    session.execution?.activeTurn === undefined &&
    (session.execution?.todos.length ?? 0) === 0 &&
    session.execution?.interruptedTurn === undefined
  );
}

export class SessionStore {
  // Serialised write chain; queued saves keep only the latest pending record
  // per session, while `save` remains a durable checkpoint.
  private pendingWrites: Promise<void> = Promise.resolve();
  private executionMutations: Promise<void> = Promise.resolve();
  private readonly queuedSessions = new Map<string, SessionRecord>();
  private queuedWriteScheduled = false;

  // New sessions are written only once they carry a message or durable task
  // state, so opening and closing an empty TUI leaves no session file.
  private readonly unsaved = new Map<string, SessionRecord>();

  private constructor(
    public readonly workspace: string,
    private readonly directory: string,
  ) {}

  public static async create(workspace: string, appPaths?: AppPaths): Promise<SessionStore> {
    const paths = await getWorkspacePaths(workspace, appPaths);
    await ensureWorkspaceDirectories(paths);
    return new SessionStore(paths.workspace, paths.sessions);
  }

  public createSession(provider: string, model: string, baseURL?: string): Promise<SessionRecord> {
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
    // Defer the first write until the session has a message; see `save`.
    this.unsaved.set(session.id, session);
    return Promise.resolve(session);
  }

  public async get(id: string): Promise<SessionRecord> {
    const pending = this.unsaved.get(id);
    if (pending !== undefined) return pending;
    return readJsonFile<SessionRecord>(sessionFile(this.directory, id));
  }

  public async save(session: SessionRecord): Promise<void> {
    if (this.unsaved.has(session.id) && shouldDeferSession(session)) {
      // Empty sessions stay in memory until their first message arrives.
      this.unsaved.set(session.id, session);
      return;
    }
    this.unsaved.delete(session.id);
    await this.enqueueWrite(session);
  }

  private enqueueWrite(session: SessionRecord): Promise<void> {
    this.queuedSessions.delete(session.id);
    const snapshot = structuredClone({ ...session, updatedAt: new Date().toISOString() });
    const write = this.pendingWrites.then(() =>
      writeJsonAtomic(sessionFile(this.directory, snapshot.id), snapshot),
    );
    this.pendingWrites = write.catch(() => undefined);
    return write;
  }

  private scheduleQueuedWrites(): void {
    if (this.queuedWriteScheduled || this.queuedSessions.size === 0) return;
    this.queuedWriteScheduled = true;
    const write = this.pendingWrites.then(async () => {
      const queued = [...this.queuedSessions.values()];
      this.queuedSessions.clear();
      const snapshots = queued.map((session) =>
        structuredClone({ ...session, updatedAt: new Date().toISOString() }),
      );
      for (const snapshot of snapshots) {
        try {
          await writeJsonAtomic(sessionFile(this.directory, snapshot.id), snapshot);
        } catch {
          // Queued saves are best effort; durable callers use `save` and observe failures.
        }
      }
    });
    this.pendingWrites = write.catch(() => undefined);
    void this.pendingWrites.then(() => {
      this.queuedWriteScheduled = false;
      if (this.queuedSessions.size > 0) this.scheduleQueuedWrites();
    }).catch(() => undefined);
  }

  /** Serialise execution-state changes and acknowledge only durable writes. */
  public updateExecution(
    session: SessionRecord,
    update: (current: SessionExecutionState) => SessionExecutionState,
  ): Promise<SessionExecutionState> {
    const change = this.executionMutations.then(async () => {
      const previous = session.execution;
      const current: SessionExecutionState = previous ?? { todos: [], queuedTurns: [] };
      const next = update(structuredClone(current));
      session.execution = next;
      try {
        await this.save(session);
      } catch (error) {
        if (previous === undefined) delete session.execution;
        else session.execution = previous;
        throw error;
      }
      return next;
    });
    this.executionMutations = change.then(() => undefined, () => undefined);
    return change;
  }

  /** Convert a task left active by a previous process into a visible interruption. */
  public async recoverInterrupted(session: SessionRecord): Promise<boolean> {
    if (session.execution?.activeTurn === undefined) return false;
    await this.updateExecution(session, (current) => {
      const active = current.activeTurn;
      const rest = { ...current };
      delete rest.activeTurn;
      return active === undefined
        ? rest
        : {
            ...rest,
            interruptedTurn: { turn: active, interruptedAt: new Date().toISOString() },
          };
    });
    return true;
  }

  /**
   * Queue a best-effort save without blocking the caller. Pending records are
   * coalesced by session ID; `flush` waits until the latest queued versions are processed.
   */
  public saveQueued(session: SessionRecord): void {
    if (this.unsaved.has(session.id) && shouldDeferSession(session)) {
      // Not persisted yet; the live record in `unsaved` is authoritative.
      this.unsaved.set(session.id, session);
      return;
    }
    this.unsaved.delete(session.id);
    this.queuedSessions.set(session.id, session);
    this.scheduleQueuedWrites();
  }

  /** Wait for every queued background save to finish. */
  public async flush(): Promise<void> {
    for (;;) {
      const pending = this.pendingWrites;
      await pending;
      if (
        pending === this.pendingWrites &&
        !this.queuedWriteScheduled &&
        this.queuedSessions.size === 0
      ) {
        return;
      }
    }
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
    this.unsaved.delete(id);
    await this.executionMutations;
    await this.flush();
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
