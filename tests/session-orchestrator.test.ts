import { describe, expect, it, vi } from 'vitest';

import { SessionOrchestrator } from '../src/core/session-orchestrator.js';
import type { AgentRunResult } from '../src/core/runtime-types.js';
import type { AgentRunner } from '../src/core/agent.js';

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
});
