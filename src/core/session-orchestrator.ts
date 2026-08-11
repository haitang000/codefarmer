import { randomUUID } from 'node:crypto';

import type { AgentRunner } from './agent.js';
import type { AgentRunResult } from './runtime-types.js';
import type { ProviderEvent, SessionRecord } from '../types.js';
import { ConfigError } from '../infra/errors.js';
import type { AgentHooks } from './hooks.js';

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
  | { type: 'turn_failed'; turn: TurnRequest; error: unknown };

export interface SessionSnapshot {
  state: 'idle' | 'running' | 'cancelling';
  activeTurn?: TurnRequest;
  queuedTurns: TurnRequest[];
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
  resolve: (result: AgentRunResult) => void;
  reject: (error: unknown) => void;
}

/** Serialises turns for one session and exposes a provider-neutral event stream. */
export class SessionOrchestrator {
  private readonly queue: QueueItem[] = [];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private active: QueueItem | undefined;
  private controller: AbortController | undefined;
  private state: SessionSnapshot['state'] = 'idle';

  public constructor(
    private readonly runner: AgentRunner,
    private readonly options: {
      maxQueue?: number;
      sessionId?: string;
      session?: SessionRecord;
      workspace?: string;
      hooks?: AgentHooks;
    } = {},
  ) {}

  public snapshot(): SessionSnapshot {
    return {
      state: this.state,
      ...(this.active === undefined ? {} : { activeTurn: { ...this.active.turn } }),
      queuedTurns: this.queue.map(({ turn }) => ({ ...turn })),
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
      this.queue.push({ turn, resolve, reject });
      this.emit({ type: 'turn_queued', turn, position: this.queue.length });
      this.emitQueue();
      void this.pump();
    });
    return { turn, promise };
  }

  public cancelActive(): boolean {
    if (this.active === undefined || this.controller === undefined) return false;
    this.state = 'cancelling';
    this.controller.abort();
    return true;
  }

  public cancelQueued(turnId?: string): number {
    const before = this.queue.length;
    const removed: QueueItem[] = [];
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (item !== undefined && (turnId === undefined || item.turn.id === turnId)) {
        this.queue.splice(index, 1);
        removed.push(item);
        item.reject(new ConfigError('排队中的任务已取消'));
      }
    }
    if (removed.length > 0) this.emitQueue();
    return before - this.queue.length;
  }

  public dispose(): void {
    this.cancelActive();
    for (const item of this.queue.splice(0)) item.reject(new ConfigError('会话已关闭'));
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
    if (this.active !== undefined) return;
    const item = this.queue.shift();
    if (item === undefined) {
      this.state = 'idle';
      return;
    }
    this.active = item;
    this.state = 'running';
    this.emitQueue();
    this.emit({ type: 'turn_started', turn: item.turn });
    const controller = new AbortController();
    this.controller = controller;
    try {
      const context = {
        turnId: item.turn.id,
        prompt: item.turn.prompt,
        workspace: this.options.workspace ?? '',
        ...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
      };
      await this.options.hooks?.beforeTurn?.(context);
      const result = await this.runner.run(item.turn.prompt, {
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
      item.resolve(result);
      this.emit({
        type: result.status === 'cancelled' ? 'turn_cancelled' : 'turn_completed',
        turn: item.turn,
        result,
      });
    } catch (error) {
      item.reject(error);
      this.emit({ type: 'turn_failed', turn: item.turn, error });
    } finally {
      this.active = undefined;
      this.controller = undefined;
      this.state = 'idle';
      void this.pump();
    }
  }
}
