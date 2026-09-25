import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SessionOrchestrator } from '../src/core/session-orchestrator.js';
import { SessionStore } from '../src/core/session-store.js';
import { getAppPaths } from '../src/infra/paths.js';
import type { AgentRunResult } from '../src/core/runtime-types.js';
import type { AgentRunner } from '../src/core/agent.js';
import type { SessionExecutionState, SessionRecord } from '../src/types.js';

function result(prompt: string, status: AgentRunResult['status'] = 'completed'): AgentRunResult {
  return {
    sessionId: 'session-1',
    status,
    message: prompt,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

describe('SessionOrchestrator', () => {
  it('runs queued prompts serially and emits lifecycle events in order', async () => {
    const resolvers: (() => void)[] = [];
    const runMock = vi.fn(async (prompt: string, options: { onEvent?: (event: never) => void }) => {
      options.onEvent?.({ type: 'text_delta', delta: prompt } as never);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return result(prompt);
    });
    const runner = { run: runMock } as unknown as AgentRunner;
    const orchestrator = new SessionOrchestrator(runner);
    const events: string[] = [];
    orchestrator.subscribe((event) => {
      if (event.type === 'provider_event') events.push(`event:${event.turn.prompt}`);
      else if (event.type === 'turn_started') events.push(`start:${event.turn.prompt}`);
      else if (event.type === 'turn_completed') events.push(`done:${event.turn.prompt}`);
    });

    const first = orchestrator.submit('first');
    const second = orchestrator.submit('second');
    await Promise.resolve();
    expect(runMock).toHaveBeenCalledTimes(1);
    resolvers.shift()?.();
    await first;
    await Promise.resolve();
    expect(runMock).toHaveBeenCalledTimes(2);
    resolvers.shift()?.();
    await second;
    expect(orchestrator.snapshot().state).toBe('idle');

    expect(events).toEqual([
      'start:first',
      'event:first',
      'done:first',
      'start:second',
      'event:second',
      'done:second',
    ]);
  });

  it('cancels queued work without starting it', async () => {
    let release: (() => void) | undefined;
    const runMock = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result('active');
    });
    const runner = { run: runMock } as unknown as AgentRunner;
    const orchestrator = new SessionOrchestrator(runner);
    const active = orchestrator.submit('active');
    const queued = orchestrator.submit('queued');
    expect(orchestrator.cancelQueued()).toBe(1);
    await expect(queued).rejects.toThrow('已取消');
    release?.();
    await active;
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('keeps auto mode attached to the queued turn', async () => {
    const runMock = vi.fn((prompt: string) => Promise.resolve(result(prompt)));
    const runner = { run: runMock } as unknown as AgentRunner;
    const orchestrator = new SessionOrchestrator(runner);

    await orchestrator.submit('automatic task', { auto: true });

    expect(runMock).toHaveBeenCalledWith('automatic task', expect.objectContaining({ auto: true }));
  });

  it('saves queued prompts, restores them paused, and expands mentions only when run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-durable-queue-'));
    try {
      const workspace = path.join(root, 'workspace');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(workspace);
      const defaults = getAppPaths();
      const store = await SessionStore.create(workspace, {
        ...defaults,
        data: root,
        sessions: path.join(root, 'sessions'),
        transactions: path.join(root, 'transactions'),
      });
      const session = await store.createSession('test', 'test');
      const firstRunner = { run: vi.fn((prompt: string) => Promise.resolve(result(prompt))) } as unknown as AgentRunner;
      const first = new SessionOrchestrator(firstRunner, { session, sessionStore: store });
      const queued = await first.enqueueDurable('inspect @src/a.ts', {
        plan: true,
        skills: ['review'],
      });
      void queued.promise.catch(() => undefined);
      const secondQueued = await first.enqueueDurable('run tests', {
        auto: true,
        skills: ['build'],
      });
      void secondQueued.promise.catch(() => undefined);
      expect((await store.get(session.id)).execution?.queuedTurns).toMatchObject([
        { prompt: 'inspect @src/a.ts', mode: 'plan', skills: ['review'] },
        { prompt: 'run tests', mode: 'auto', skills: ['build'] },
      ]);

      const restoredSession = await store.get(session.id);
      let expanded = 'first contents';
      const runnerMock = vi.fn((prompt: string) => Promise.resolve(result(prompt)));
      const restored = new SessionOrchestrator({ run: runnerMock } as unknown as AgentRunner, {
        session: restoredSession,
        sessionStore: store,
        preparePrompt: (prompt) => Promise.resolve(`${prompt}: ${expanded}`),
      });
      const queueErrors: unknown[] = [];
      restored.subscribe((event) => {
        if (event.type === 'queue_error') queueErrors.push(event.error);
      });
      expect(restored.snapshot()).toMatchObject({ paused: true, queuedTurns: [{ plan: true }, { auto: true }] });
      await Promise.resolve();
      expect(runnerMock).not.toHaveBeenCalled();
      expanded = 'new contents';
      restored.continueQueued();
      restored.continueQueued();
      await vi.waitFor(() => expect(runnerMock.mock.calls.length + queueErrors.length).toBeGreaterThan(0));
      expect(queueErrors).toEqual([]);
      expect(runnerMock).toHaveBeenNthCalledWith(
        1,
        'inspect @src/a.ts: new contents',
        expect.objectContaining({ plan: true, skills: ['review'] }),
      );
      await vi.waitFor(() => expect(runnerMock).toHaveBeenCalledTimes(2));
      expect(runnerMock).toHaveBeenNthCalledWith(
        2,
        'run tests: new contents',
        expect.objectContaining({ auto: true, skills: ['build'] }),
      );
      await vi.waitFor(() => expect(restoredSession.execution?.activeTurn).toBeUndefined());
      expect(restoredSession.execution?.queuedTurns).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the queue unchanged when durable enqueue cannot be saved', async () => {
    const session = {
      version: 1 as const,
      id: 'session-failure',
      workspace: 'test',
      provider: 'test',
      model: 'test',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      toolCalls: [],
    };
    const store = {
      updateExecution: vi.fn(() => Promise.reject(new Error('disk full'))),
    } as unknown as SessionStore;
    const runnerMock = vi.fn();
    const runner = { run: runnerMock } as unknown as AgentRunner;
    const orchestrator = new SessionOrchestrator(runner, { session, sessionStore: store });
    await expect(orchestrator.enqueueDurable('keep this draft')).rejects.toThrow('disk full');
    expect(orchestrator.snapshot().queuedTurns).toEqual([]);
    expect(runnerMock).not.toHaveBeenCalled();
  });

  it('enforces the pending queue limit before accepting another durable task', async () => {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      version: 1,
      id: 'session-limit',
      workspace: 'test',
      provider: 'test',
      model: 'test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      messages: [],
      toolCalls: [],
    };
    const store = {
      updateExecution: vi.fn((
        target: SessionRecord,
        update: (current: SessionExecutionState) => SessionExecutionState,
      ) => {
        target.execution = update(target.execution ?? { todos: [], queuedTurns: [] });
        return Promise.resolve(target.execution);
      }),
    } as unknown as SessionStore;
    const runnerMock = vi.fn();
    const orchestrator = new SessionOrchestrator({ run: runnerMock } as unknown as AgentRunner, {
      session,
      sessionStore: store,
    });
    for (let index = 0; index < 8; index += 1) {
      const queued = await orchestrator.enqueueDurable(`task ${String(index)}`);
      void queued.promise.catch(() => undefined);
    }
    await expect(orchestrator.enqueueDurable('ninth')).rejects.toThrow('队列已满');
    expect(session.execution?.queuedTurns).toHaveLength(8);
    expect(await orchestrator.clearQueued()).toBe(8);
    expect(session.execution?.queuedTurns).toEqual([]);
    orchestrator.continueQueued();
    expect(runnerMock).not.toHaveBeenCalled();
  });

  it('keeps pending durable work and records the active turn on exit', async () => {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      version: 1,
      id: 'session-live',
      workspace: 'test',
      provider: 'test',
      model: 'test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      messages: [],
      toolCalls: [],
    };
    const store = {
      updateExecution: vi.fn((
        target: SessionRecord,
        update: (current: SessionExecutionState) => SessionExecutionState,
      ) => {
        target.execution = update(target.execution ?? { todos: [], queuedTurns: [] });
        return Promise.resolve(target.execution);
      }),
    } as unknown as SessionStore;
    let release: (() => void) | undefined;
    const runnerMock = vi.fn(async (prompt: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result(prompt);
    });
    const orchestrator = new SessionOrchestrator({ run: runnerMock } as unknown as AgentRunner, {
      session,
      sessionStore: store,
    });
    const first = await orchestrator.enqueueDurable('first');
    orchestrator.continueQueued();
    await vi.waitFor(() => expect(runnerMock).toHaveBeenCalledTimes(1));
    const second = await orchestrator.enqueueDurable('second', { auto: true, skills: ['build'] });
    expect(session.execution?.queuedTurns).toMatchObject([
      { prompt: 'second', mode: 'auto', skills: ['build'] },
    ]);
    await orchestrator.interruptForExit();
    expect(session.execution?.interruptedTurn?.turn.prompt).toBe('first');
    expect(session.execution?.queuedTurns).toHaveLength(1);
    release?.();
    await first.promise;
    await vi.waitFor(() => expect(orchestrator.snapshot().state).toBe('idle'));
    expect(runnerMock).toHaveBeenCalledTimes(1);
    expect(session.execution?.queuedTurns).toHaveLength(1);
    void second.promise.catch(() => undefined);
  });
});
