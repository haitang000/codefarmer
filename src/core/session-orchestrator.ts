import { randomUUID } from 'node:crypto';

import type { AgentRunner } from './agent.js';
import type { AgentRunResult } from './runtime-types.js';
import type { PersistedTurn, ProviderEvent, SessionRecord } from '../types.js';
import { ConfigError } from '../infra/errors.js';
import type { AgentHooks } from './hooks.js';
import type { SessionStore } from './session-store.js';

export const DEFAULT_TURN_QUEUE_LIMIT = 8;

export interface TurnRequest {
  id: string;
  prompt: string;
  displayPrompt?: string;
  plan?: boolean;
  auto?: boolean;
  skills?: string[];
  createdAt: string;
}

export type SessionEvent =
  | { type: 'turn_queued'; turn: TurnRequest; position: number }
  | { type: 'queue_changed'; queued: TurnRequest[] }
  | { type: 'turn_started'; turn: TurnRequest }
  | { type: 'provider_event'; turn: TurnRequest; event: ProviderEvent }
  | { type: 'turn_completed'; turn: TurnRequest; result: AgentRunResult }
  | { type: 'turn_cancelled'; turn: TurnRequest; result: AgentRunResult }
  | { type: 'turn_failed'; turn: TurnRequest; error: unknown }
  | { type: 'queue_error'; error: unknown };

export interface SessionSnapshot {
  state: 'idle' | 'running' | 'cancelling';
  activeTurn?: TurnRequest;
  queuedTurns: TurnRequest[];
  paused: boolean;
}

export interface SubmitTurnOptions {
  displayPrompt?: string;
  plan?: boolean;
  auto?: boolean;
  skills?: string[];
}

export interface EnqueuedTurn {
  turn: TurnRequest;
  promise: Promise<AgentRunResult>;
}

interface QueueItem {
  turn: TurnRequest;
  resolve?: (result: AgentRunResult) => void;
  reject?: (error: unknown) => void;
  durable: boolean;
}

function persistTurn(turn: TurnRequest): PersistedTurn {
  return {
    id: turn.id,
    prompt: turn.prompt,
    ...(turn.displayPrompt === undefined ? {} : { displayPrompt: turn.displayPrompt }),
    mode: turn.plan === true ? 'plan' : turn.auto === true ? 'auto' : 'code',
    skills: [...(turn.skills ?? [])],
    createdAt: turn.createdAt,
  };
}

function restoreTurn(turn: PersistedTurn): TurnRequest {
  return {
    id: turn.id,
    prompt: turn.prompt,
    ...(turn.displayPrompt === undefined ? {} : { displayPrompt: turn.displayPrompt }),
    ...(turn.mode === 'plan' ? { plan: true } : {}),
    ...(turn.mode === 'auto' ? { auto: true } : {}),
    skills: [...turn.skills],
    createdAt: turn.createdAt,
  };
}

/** Serialises turns for one session and exposes a provider-neutral event stream. */
export class SessionOrchestrator {
  private readonly queue: QueueItem[] = [];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private active: QueueItem | undefined;
  private controller: AbortController | undefined;
  private state: SessionSnapshot['state'] = 'idle';
  private paused: boolean;
  private pumping = false;
  private leaving = false;

  public constructor(
    private readonly runner: AgentRunner,
    private readonly options: {
      maxQueue?: number;
      sessionId?: string;
      session?: SessionRecord;
      workspace?: string;
      hooks?: AgentHooks;
      sessionStore?: SessionStore;
      preparePrompt?: (prompt: string) => Promise<string>;
    } = {},
  ) {
    const restored = options.session?.execution?.queuedTurns ?? [];
    this.queue.push(...restored.map((turn) => ({ turn: restoreTurn(turn), durable: true })));
    this.paused = restored.length > 0;
  }

  public snapshot(): SessionSnapshot {
    return {
      state: this.state,
      ...(this.active === undefined ? {} : { activeTurn: { ...this.active.turn } }),
      queuedTurns: this.queue.map(({ turn }) => ({ ...turn })),
      paused: this.paused,
    };
  }

  public subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public submit(prompt: string, options: SubmitTurnOptions = {}): Promise<AgentRunResult> {
    return this.enqueue(prompt, options).promise;
  }

  public enqueue(prompt: string, options: SubmitTurnOptions = {}): EnqueuedTurn {
    const value = prompt.trim();
    if (value.length === 0) {
      const turn: TurnRequest = {
        id: randomUUID(),
        prompt: '',
        createdAt: new Date().toISOString(),
      };
      return { turn, promise: Promise.reject(new ConfigError('任务描述不能为空')) };
    }
    const limit = this.options.maxQueue ?? DEFAULT_TURN_QUEUE_LIMIT;
    if (this.queue.length + (this.active === undefined ? 0 : 1) >= limit + 1) {
      const turn: TurnRequest = {
        id: randomUUID(),
        prompt: value,
        createdAt: new Date().toISOString(),
      };
      return {
        turn,
        promise: Promise.reject(new ConfigError(`任务队列已满（最多 ${String(limit)} 项）`)),
      };
    }
    const turn: TurnRequest = {
      id: randomUUID(),
      prompt: value,
      ...(options.displayPrompt === undefined ? {} : { displayPrompt: options.displayPrompt }),
      ...(options.plan === undefined ? {} : { plan: options.plan }),
      ...(options.auto === undefined ? {} : { auto: options.auto }),
      ...(options.skills === undefined ? {} : { skills: [...options.skills] }),
      createdAt: new Date().toISOString(),
    };
    const promise = new Promise<AgentRunResult>((resolve, reject) => {
      this.queue.push({ turn, resolve, reject, durable: false });
      this.emit({ type: 'turn_queued', turn, position: this.queue.length });
      this.emitQueue();
      void this.pump();
    });
    return { turn, promise };
  }

  /** Persist a raw prompt before acknowledging it to the TUI. */
  public async enqueueDurable(
    prompt: string,
    options: SubmitTurnOptions = {},
  ): Promise<EnqueuedTurn> {
    const value = prompt.trim();
    if (value.length === 0) throw new ConfigError('任务描述不能为空');
    const limit = this.options.maxQueue ?? DEFAULT_TURN_QUEUE_LIMIT;
    if (this.queue.length >= limit) throw new ConfigError(`任务队列已满（最多 ${String(limit)} 项）`);
    const session = this.options.session;
    const store = this.options.sessionStore;
    if (session === undefined || store === undefined) throw new ConfigError('没有可保存的会话');
    const turn: TurnRequest = {
      id: randomUUID(),
      prompt: value,
      ...(options.displayPrompt === undefined ? {} : { displayPrompt: options.displayPrompt }),
      ...(options.plan === undefined ? {} : { plan: options.plan }),
      ...(options.auto === undefined ? {} : { auto: options.auto }),
      skills: [...(options.skills ?? [])],
      createdAt: new Date().toISOString(),
    };
    await store.updateExecution(session, (current) => {
      if (current.queuedTurns.length >= limit) {
        throw new ConfigError(`任务队列已满（最多 ${String(limit)} 项）`);
      }
      return { ...current, queuedTurns: [...current.queuedTurns, persistTurn(turn)] };
    });
    let resolvePromise!: (result: AgentRunResult) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<AgentRunResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.queue.push({ turn, resolve: resolvePromise, reject: rejectPromise, durable: true });
    this.emit({ type: 'turn_queued', turn, position: this.queue.length });
    this.emitQueue();
    return { turn, promise };
  }

  /** Continue this queue only after the UI has explicitly requested it. */
  public continueQueued(): void {
    if (!this.paused) {
      void this.pump();
      return;
    }
    this.paused = false;
    void this.pump();
  }

  public async clearQueued(): Promise<number> {
    const session = this.options.session;
    const store = this.options.sessionStore;
    if (session !== undefined && store !== undefined) {
      await store.updateExecution(session, (current) => ({ ...current, queuedTurns: [] }));
    }
    const removed = this.queue.splice(0);
    for (const item of removed) item.reject?.(new ConfigError('排队中的任务已取消'));
    this.emitQueue();
    return removed.length;
  }

  public cancelActive(): boolean {
    if (this.active === undefined || this.controller === undefined) return false;
    this.state = 'cancelling';
    this.controller.abort();
    return true;
  }

  /** Stop the active turn for TUI exit, retaining pending work and its interruption note. */
  public async interruptForExit(): Promise<void> {
    this.leaving = true;
    this.paused = true;
    this.cancelActive();
    const active = this.active?.turn;
    if (active !== undefined && this.options.session !== undefined && this.options.sessionStore !== undefined) {
      try {
        await this.options.sessionStore.updateExecution(this.options.session, (current) => {
          const rest = { ...current };
          delete rest.activeTurn;
          return {
            ...rest,
            interruptedTurn: { turn: persistTurn(active), interruptedAt: new Date().toISOString() },
          };
        });
      } catch (error) {
        this.leaving = false;
        this.paused = false;
        throw error;
      }
    }
  }

  public cancelQueued(turnId?: string): number {
    const before = this.queue.length;
    const removed: QueueItem[] = [];
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (
        item !== undefined &&
        !item.durable &&
        (turnId === undefined || item.turn.id === turnId)
      ) {
        this.queue.splice(index, 1);
        removed.push(item);
        item.reject?.(new ConfigError('排队中的任务已取消'));
      }
    }
    if (removed.length > 0) this.emitQueue();
    return before - this.queue.length;
  }

  public dispose(): void {
    this.cancelActive();
    for (const item of this.queue.splice(0)) item.reject?.(new ConfigError('会话已关闭'));
    this.emitQueue();
    this.listeners.clear();
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitQueue(): void {
    this.emit({ type: 'queue_changed', queued: this.queue.map(({ turn }) => ({ ...turn })) });
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.paused) return;
    this.pumping = true;
    const item = this.queue[0];
    if (item === undefined) {
      this.state = 'idle';
      this.pumping = false;
      return;
    }
    if (item.durable && this.options.session !== undefined && this.options.sessionStore !== undefined) {
      try {
        await this.options.sessionStore.updateExecution(this.options.session, (current) => ({
          ...current,
          queuedTurns: current.queuedTurns.filter((turn) => turn.id !== item.turn.id),
          activeTurn: persistTurn(item.turn),
        }));
        if (this.queue[0] !== item) {
          await this.options.sessionStore.updateExecution(this.options.session, (current) => {
            const rest = { ...current };
            if (rest.activeTurn?.id === item.turn.id) delete rest.activeTurn;
            return rest;
          });
          this.pumping = false;
          void this.pump();
          return;
        }
        if (this.snapshot().paused) {
          await this.options.sessionStore.updateExecution(this.options.session, (current) => {
            const rest = { ...current };
            delete rest.activeTurn;
            return {
              ...rest,
              queuedTurns: [persistTurn(item.turn), ...current.queuedTurns.filter((turn) => turn.id !== item.turn.id)],
            };
          });
          this.pumping = false;
          return;
        }
      } catch (error) {
        this.paused = true;
        this.emit({ type: 'queue_error', error });
        this.pumping = false;
        return;
      }
    }
    this.queue.shift();
    this.active = item;
    this.state = 'running';
    this.emitQueue();
    this.emit({ type: 'turn_started', turn: item.turn });
    const controller = new AbortController();
    this.controller = controller;
    let completed: AgentRunResult | undefined;
    let failed: unknown;
    try {
      const context = {
        turnId: item.turn.id,
        prompt: item.turn.prompt,
        workspace: this.options.workspace ?? '',
        ...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
      };
      await this.options.hooks?.beforeTurn?.(context);
      const prompt = item.durable
        ? (await this.options.preparePrompt?.(item.turn.prompt)) ?? item.turn.prompt
        : item.turn.prompt;
      const result = await this.runner.run(prompt, {
        history: true,
        signal: controller.signal,
        ...(this.options.session === undefined ? {} : { session: this.options.session }),
        ...(item.turn.plan === undefined ? {} : { plan: item.turn.plan }),
        ...(item.turn.auto === undefined ? {} : { auto: item.turn.auto }),
        ...(item.turn.skills === undefined ? {} : { skills: item.turn.skills }),
        onEvent: (event) => {
          this.emit({ type: 'provider_event', turn: item.turn, event });
          void this.options.hooks?.onProviderEvent?.(context, event);
        },
      });
      try {
        await this.options.hooks?.afterTurn?.(context, result);
      } catch {
        // Post-turn integrations are observers and must not rewrite a result.
      }
      completed = result;
    } catch (error) {
      failed = error;
    } finally {
      if (item.durable && this.options.session !== undefined && this.options.sessionStore !== undefined) {
        try {
          await this.options.sessionStore.updateExecution(this.options.session, (current) => {
            const rest = { ...current };
            delete rest.activeTurn;
            return this.leaving
              ? {
                  ...rest,
                  interruptedTurn: { turn: persistTurn(item.turn), interruptedAt: new Date().toISOString() },
                }
              : rest;
          });
        } catch (error) {
          this.paused = true;
          this.emit({ type: 'queue_error', error });
        }
      }
      this.active = undefined;
      this.controller = undefined;
      this.state = 'idle';
      this.pumping = false;
      if (completed !== undefined) {
        item.resolve?.(completed);
        this.emit({
          type: completed.status === 'cancelled' ? 'turn_cancelled' : 'turn_completed',
          turn: item.turn,
          result: completed,
        });
      } else {
        item.reject?.(failed);
        this.emit({ type: 'turn_failed', turn: item.turn, error: failed });
      }
      void this.pump();
    }
  }
}
