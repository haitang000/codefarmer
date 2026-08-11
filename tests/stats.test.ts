import { describe, expect, it } from 'vitest';

import {
  MODEL_PRICES_PER_MT,
  computeWorkspaceStats,
  estimateCostUsd,
  lookupModelPrice,
  type ModelStat,
  type WorkspaceStats,
} from '../src/core/stats.js';
import type { SessionRecord, TokenUsage } from '../src/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let sequence = 0;

function session(overrides: Partial<SessionRecord> & { model: string }): SessionRecord {
  sequence += 1;
  const now = new Date().toISOString();
  return {
    version: 1,
    id: `session-${String(sequence)}`,
    workspace: '/tmp/workspace',
    provider: 'openai',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    messages: [],
    toolCalls: [],
    ...overrides,
  };
}

function usage(inputTokens: number, outputTokens: number, extra?: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...extra,
  };
}

function priceFor(prefix: string) {
  const found = MODEL_PRICES_PER_MT.find(([candidate]) => candidate === prefix);
  if (found === undefined) throw new Error(`价格表缺少 ${prefix}`);
  return found[1];
}

function modelStat(stats: WorkspaceStats, model: string): ModelStat {
  const stat = stats.byModel.find((candidate) => candidate.model === model);
  if (stat === undefined) throw new Error(`缺少模型统计: ${model}`);
  return stat;
}

describe('lookupModelPrice', () => {
  it('matches prices case-insensitively at family boundaries', () => {
    expect(lookupModelPrice('gpt-5.6-sol')).toMatchObject({
      inputPerMT: 5,
      outputPerMT: 30,
      cachedInputPerMT: 0.5,
    });
    expect(lookupModelPrice('gpt-5-mini')?.inputPerMT).toBe(0.25);
    expect(lookupModelPrice('GPT-5-MINI')?.inputPerMT).toBe(0.25);
    // Longest matching prefix wins, not the first table entry.
    expect(lookupModelPrice('gpt-5')?.inputPerMT).toBe(1.25);
    expect(lookupModelPrice('gpt-5-mini')?.inputPerMT).not.toBe(1.25);
    // A dot is not a family boundary: an unlisted variant must not be priced as `gpt-5`.
    expect(lookupModelPrice('gpt-5.6-solish')).toBeUndefined();
    // Gateway-style names match through the segment after the last `/`.
    expect(lookupModelPrice('openai/gpt-4o-mini')?.inputPerMT).toBe(0.15);
    // Suffixes after a `-` are fine (version stamps like `-001`).
    expect(lookupModelPrice('gemini-2.5-flash-001')?.inputPerMT).toBe(0.3);
    expect(lookupModelPrice('')).toBeUndefined();
    expect(lookupModelPrice('not-a-real-model')).toBeUndefined();
  });

  it('covers every advertised provider family with at least one entry', () => {
    for (const family of ['gpt-5', 'gpt-4', 'o1', 'gemini', 'grok', 'deepseek', 'kimi']) {
      expect(MODEL_PRICES_PER_MT.some(([prefix]) => prefix.startsWith(family))).toBe(true);
    }
  });

  it('uses the current public cache rates for Gemini 2.5 models', () => {
    expect(lookupModelPrice('gemini-2.5-pro')?.cachedInputPerMT).toBe(0.125);
    expect(lookupModelPrice('gemini-2.5-flash')?.cachedInputPerMT).toBe(0.03);
    expect(lookupModelPrice('gemini-2.5-flash-lite')?.cachedInputPerMT).toBe(0.01);
  });
});

describe('estimateCostUsd', () => {
  it('bills cached input at the cached rate when provided', () => {
    const price = priceFor('gpt-5-mini');
    const cost = estimateCostUsd(
      usage(1_000_000, 100_000, { cachedInputTokens: 500_000 }),
      price,
    );
    // (500k miss * 0.25 + 500k cached * 0.025 + 100k * 2) / 1M
    expect(cost).toBeCloseTo(0.3375, 9);
  });

  it('falls back to the full input rate when cached pricing is missing', () => {
    const price = priceFor('grok-beta');
    expect(price.cachedInputPerMT).toBeUndefined();
    const cost = estimateCostUsd(
      usage(1_000_000, 0, { cachedInputTokens: 1_000_000 }),
      price,
    );
    expect(cost).toBeCloseTo(5, 9);
  });

  it('clamps corrupt usage values to zero instead of poisoning totals', () => {
    const price = priceFor('gpt-5-mini');
    expect(estimateCostUsd(usage(Number.NaN, -5), price)).toBe(0);
  });
});

describe('computeWorkspaceStats', () => {
  it('returns zeroed stats for an empty workspace', () => {
    const stats = computeWorkspaceStats([]);
    expect(stats).toEqual({
      totalSessions: 0,
      sessionsWithUsage: 0,
      statusCounts: { active: 0, completed: 0, cancelled: 0, failed: 0 },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
      totalMessages: 0,
      totalToolCalls: 0,
      recent: { last7Days: 0, last30Days: 0 },
      byModel: [],
      costUnknownModels: [],
      estimatedCostUsd: 0,
    });
  });

  it('aggregates usage, statuses, messages, and tool calls across sessions', () => {
    const now = new Date().toISOString();
    const sessions = [
      session({
        model: 'gpt-5-mini',
        status: 'completed',
        updatedAt: now,
        messages: [
          { id: 'm1', role: 'user', content: 'a', createdAt: now },
          { id: 'm2', role: 'assistant', content: 'b', createdAt: now },
        ],
        toolCalls: [
          {
            callId: 'c1',
            toolName: 'list_files',
            arguments: {},
            success: true,
            startedAt: now,
          },
        ],
        usage: usage(1_000, 500, { reasoningTokens: 100, cachedInputTokens: 200 }),
      }),
      session({
        model: 'gpt-5-mini',
        status: 'failed',
        updatedAt: now,
        messages: [{ id: 'm3', role: 'user', content: 'c', createdAt: now }],
        toolCalls: [],
        usage: usage(2_000, 0),
      }),
      // Records no usage: contributes to totals but not to usage or cost.
      session({
        model: 'gemini-2.5-flash',
        provider: 'gemini',
        status: 'active',
        updatedAt: now,
        messages: [
          { id: 'm4', role: 'user', content: 'd', createdAt: now },
          { id: 'm5', role: 'assistant', content: 'e', createdAt: now },
          { id: 'm6', role: 'user', content: 'f', createdAt: now },
        ],
        toolCalls: [
          { callId: 'c2', toolName: 'grep', arguments: {}, success: true, startedAt: now },
          { callId: 'c3', toolName: 'grep', arguments: {}, success: false, startedAt: now },
        ],
      }),
    ];

    const stats = computeWorkspaceStats(sessions);
    expect(stats.totalSessions).toBe(3);
    expect(stats.sessionsWithUsage).toBe(2);
    expect(stats.statusCounts).toEqual({ active: 1, completed: 1, cancelled: 0, failed: 1 });
    expect(stats.usage).toEqual({
      inputTokens: 3_000,
      outputTokens: 500,
      totalTokens: 3_500,
      reasoningTokens: 100,
      cachedInputTokens: 200,
    });
    expect(stats.totalMessages).toBe(6);
    expect(stats.totalToolCalls).toBe(3);
    // Sessions without usage are excluded from per-model stats.
    expect(stats.byModel).toHaveLength(1);
    expect(stats.byModel[0]).toMatchObject({
      model: 'gpt-5-mini',
      provider: 'openai',
      sessions: 2,
      priceMatched: true,
    });
    expect(stats.costUnknownModels).toEqual([]);
    expect(stats.estimatedCostUsd).toBeCloseTo(0.001705, 9);
  });

  it('groups by model, sorts by tokens, and follows the most recent provider', () => {
    const now = Date.now();
    const sessions = [
      session({
        model: 'gpt-5-mini',
        provider: 'openai',
        updatedAt: new Date(now - 3_600_000).toISOString(),
        usage: usage(2_000, 100),
      }),
      session({
        model: 'gpt-5-mini',
        provider: 'gateway',
        updatedAt: new Date(now).toISOString(),
        usage: usage(100, 0),
      }),
      session({
        model: 'gemini-2.5-flash',
        provider: 'gemini',
        updatedAt: new Date(now).toISOString(),
        usage: usage(5_000, 0),
      }),
    ];

    const stats = computeWorkspaceStats(sessions);
    expect(stats.byModel.map((stat) => stat.model)).toEqual(['gemini-2.5-flash', 'gpt-5-mini']);
    const gpt = modelStat(stats, 'gpt-5-mini');
    expect(gpt.sessions).toBe(2);
    expect(gpt.provider).toBe('gateway');
    expect(gpt.usage.totalTokens).toBe(2_200);
  });

  it('excludes unknown models from cost and reports them separately', () => {
    const sessions = [
      session({ model: 'gpt-5-mini', usage: usage(1_000_000, 0) }),
      session({ model: 'gpt-5.6-solish', provider: 'openai', usage: usage(100, 100) }),
    ];
    const stats = computeWorkspaceStats(sessions);

    expect(stats.costUnknownModels).toEqual(['gpt-5.6-solish']);
    const unknown = modelStat(stats, 'gpt-5.6-solish');
    expect(unknown.priceMatched).toBe(false);
    expect(unknown.estimatedCostUsd).toBe(0);
    const known = modelStat(stats, 'gpt-5-mini');
    expect(known.priceMatched).toBe(true);
    expect(known.estimatedCostUsd).toBeCloseTo(0.25, 9);
    // The unknown model's cost is not silently counted as zero in the total.
    expect(stats.estimatedCostUsd).toBeCloseTo(0.25, 9);
  });

  it('counts recent activity in 7- and 30-day windows by updatedAt', () => {
    const now = Date.now();
    const sessions = [
      session({ model: 'gpt-5-mini', updatedAt: new Date(now - 2 * DAY_MS).toISOString() }),
      session({ model: 'gpt-5-mini', updatedAt: new Date(now - 20 * DAY_MS).toISOString() }),
      session({ model: 'gpt-5-mini', updatedAt: new Date(now - 45 * DAY_MS).toISOString() }),
      session({ model: 'gpt-5-mini', updatedAt: 'not-a-date' }),
    ];
    const stats = computeWorkspaceStats(sessions);
    expect(stats.totalSessions).toBe(4);
    expect(stats.recent).toEqual({ last7Days: 1, last30Days: 2 });
  });
});
