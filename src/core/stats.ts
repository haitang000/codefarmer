import type { SessionRecord, SessionStatus, TokenUsage } from '../types.js';

/**
 * Token-usage and cost statistics for a workspace, computed purely from
 * persisted `SessionRecord`s. The module performs no I/O: pass the result of
 * `SessionStore#list()` (or any subset of sessions) to
 * {@link computeWorkspaceStats} and render the result however you like.
 */

/** Approximate public list prices in USD per 1M tokens, matched by model-family prefix. */
export interface ModelPrice {
  /** USD per 1M input tokens (cache miss). */
  inputPerMT: number;
  /** USD per 1M output tokens. */
  outputPerMT: number;
  /** USD per 1M cached input tokens; falls back to `inputPerMT` when omitted. */
  cachedInputPerMT?: number;
}

/** Cumulative token counts, 0-filled so the shape is stable for JSON output. */
export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

/** Per-model usage and estimated cost. */
export interface ModelStat {
  model: string;
  /** Provider of the most recently updated session recorded for this model. */
  provider: string;
  /** Number of sessions with recorded usage for this model. */
  sessions: number;
  usage: TokenUsageTotals;
  /** Estimated cost in USD; 0 when the model did not match the price table. */
  estimatedCostUsd: number;
  /** Whether the model matched {@link MODEL_PRICES_PER_MT}. */
  priceMatched: boolean;
}

/** Session counts within trailing time windows, measured by `updatedAt`. */
export interface RecentActivity {
  /** Sessions updated within the trailing 7 days. */
  last7Days: number;
  /** Sessions updated within the trailing 30 days. */
  last30Days: number;
}

/** Aggregate workspace statistics. */
export interface WorkspaceStats {
  totalSessions: number;
  /** Sessions that recorded token usage; only these contribute to usage and cost. */
  sessionsWithUsage: number;
  statusCounts: Record<SessionStatus, number>;
  usage: TokenUsageTotals;
  totalMessages: number;
  totalToolCalls: number;
  recent: RecentActivity;
  /** Per-model usage and cost, most tokens first. */
  byModel: ModelStat[];
  /**
   * Models with recorded usage that did not match the price table. They are
   * excluded from `estimatedCostUsd`; their cost is unknown rather than zero.
   */
  costUnknownModels: string[];
  /** Sum of `estimatedCostUsd` across matched models, in USD. */
  estimatedCostUsd: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Approximate public list prices in USD per 1M tokens, keyed by model-family
 * prefix. Matching is case-insensitive, prefers the longest prefix, and only
 * matches at a family boundary (`-`, `/`, or end of name) so a hypothetical
 * `gpt-5.6-sol` is not silently priced as `gpt-5`. Prices change over time;
 * treat cost output as an estimate and consult the provider for billing.
 */
export const MODEL_PRICES_PER_MT: readonly (readonly [string, ModelPrice])[] = [
  // OpenAI
  ['gpt-5-nano', { inputPerMT: 0.05, outputPerMT: 0.4, cachedInputPerMT: 0.005 }],
  ['gpt-5-mini', { inputPerMT: 0.25, outputPerMT: 2, cachedInputPerMT: 0.025 }],
  ['gpt-5-pro', { inputPerMT: 2.5, outputPerMT: 20, cachedInputPerMT: 0.25 }],
  ['gpt-5', { inputPerMT: 1.25, outputPerMT: 10, cachedInputPerMT: 0.125 }],
  ['gpt-4.5', { inputPerMT: 75, outputPerMT: 150, cachedInputPerMT: 37.5 }],
  ['gpt-4.1-mini', { inputPerMT: 0.4, outputPerMT: 1.6, cachedInputPerMT: 0.04 }],
  ['gpt-4.1-nano', { inputPerMT: 0.1, outputPerMT: 0.4, cachedInputPerMT: 0.01 }],
  ['gpt-4.1', { inputPerMT: 2, outputPerMT: 8, cachedInputPerMT: 0.5 }],
  ['gpt-4o-mini', { inputPerMT: 0.15, outputPerMT: 0.6, cachedInputPerMT: 0.075 }],
  ['gpt-4o', { inputPerMT: 2.5, outputPerMT: 10, cachedInputPerMT: 1.25 }],
  ['gpt-4-turbo', { inputPerMT: 10, outputPerMT: 30, cachedInputPerMT: 2.5 }],
  ['gpt-4', { inputPerMT: 30, outputPerMT: 60, cachedInputPerMT: 15 }],
  ['o4-mini', { inputPerMT: 1.1, outputPerMT: 4.4, cachedInputPerMT: 0.55 }],
  ['o3-mini', { inputPerMT: 1.1, outputPerMT: 4.4, cachedInputPerMT: 0.55 }],
  ['o3', { inputPerMT: 2, outputPerMT: 8, cachedInputPerMT: 0.5 }],
  ['o1-pro', { inputPerMT: 150, outputPerMT: 600, cachedInputPerMT: 75 }],
  ['o1-mini', { inputPerMT: 3, outputPerMT: 12, cachedInputPerMT: 1.5 }],
  ['o1', { inputPerMT: 15, outputPerMT: 60, cachedInputPerMT: 7.5 }],
  // Google Gemini
  ['gemini-2.5-pro', { inputPerMT: 1.25, outputPerMT: 10, cachedInputPerMT: 0.3125 }],
  ['gemini-2.5-flash-lite', { inputPerMT: 0.1, outputPerMT: 0.4, cachedInputPerMT: 0.025 }],
  ['gemini-2.5-flash', { inputPerMT: 0.3, outputPerMT: 2.5, cachedInputPerMT: 0.075 }],
  ['gemini-2.0-flash', { inputPerMT: 0.1, outputPerMT: 0.4, cachedInputPerMT: 0.025 }],
  ['gemini-1.5-pro', { inputPerMT: 1.25, outputPerMT: 5, cachedInputPerMT: 0.3125 }],
  ['gemini-1.5-flash', { inputPerMT: 0.075, outputPerMT: 0.3, cachedInputPerMT: 0.01875 }],
  // xAI Grok
  ['grok-4', { inputPerMT: 3, outputPerMT: 15, cachedInputPerMT: 0.3 }],
  ['grok-3', { inputPerMT: 3, outputPerMT: 15, cachedInputPerMT: 0.3 }],
  ['grok-2', { inputPerMT: 2, outputPerMT: 10, cachedInputPerMT: 0.2 }],
  ['grok-beta', { inputPerMT: 5, outputPerMT: 15 }],
  // DeepSeek
  ['deepseek-chat', { inputPerMT: 0.27, outputPerMT: 1.1, cachedInputPerMT: 0.07 }],
  ['deepseek-reasoner', { inputPerMT: 0.55, outputPerMT: 2.19, cachedInputPerMT: 0.14 }],
  ['deepseek-coder', { inputPerMT: 0.14, outputPerMT: 0.28, cachedInputPerMT: 0.014 }],
  // Kimi (Moonshot)
  ['kimi-k2.5', { inputPerMT: 0.6, outputPerMT: 2.5, cachedInputPerMT: 0.15 }],
  ['kimi-k2', { inputPerMT: 0.6, outputPerMT: 2.5, cachedInputPerMT: 0.15 }],
];

/** Treat corrupt or missing token counts as zero instead of poisoning totals. */
function safeCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function emptyUsage(): TokenUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  };
}

function addUsage(target: TokenUsageTotals, usage: TokenUsage): void {
  target.inputTokens += safeCount(usage.inputTokens);
  target.outputTokens += safeCount(usage.outputTokens);
  target.totalTokens += safeCount(usage.totalTokens);
  target.reasoningTokens += safeCount(usage.reasoningTokens);
  target.cachedInputTokens += safeCount(usage.cachedInputTokens);
}

/** Match only at a family boundary so `gpt-5.6-sol` is not priced as `gpt-5`. */
function matchesAtBoundary(model: string, prefix: string): boolean {
  if (!model.startsWith(prefix)) return false;
  const next = model[prefix.length];
  return next === undefined || next === '-' || next === '/';
}

/**
 * Look up the closest price-table entry for a model. Matching is
 * case-insensitive and prefers the longest prefix; `openai/gpt-5-mini`-style
 * gateway names match through the segment after the last `/`.
 */
export function lookupModelPrice(model: string): ModelPrice | undefined {
  const candidates = [model];
  const slash = model.lastIndexOf('/');
  if (slash !== -1 && slash < model.length - 1) candidates.push(model.slice(slash + 1));

  let best: ModelPrice | undefined;
  let bestLength = -1;
  for (const candidate of candidates) {
    const normalized = candidate.trim().toLowerCase();
    if (normalized.length === 0) continue;
    for (const [prefix, price] of MODEL_PRICES_PER_MT) {
      if (prefix.length > bestLength && matchesAtBoundary(normalized, prefix)) {
        best = price;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Estimate the cost in USD for one usage record at the given price. Cached
 * input tokens are billed at the cached rate; when a price entry omits
 * `cachedInputPerMT`, the full input rate is used as a conservative bound.
 */
export function estimateCostUsd(usage: TokenUsage, price: ModelPrice): number {
  const input = safeCount(usage.inputTokens);
  const cached = Math.min(safeCount(usage.cachedInputTokens), input);
  const output = safeCount(usage.outputTokens);
  const cachedPrice = price.cachedInputPerMT ?? price.inputPerMT;
  return (
    ((input - cached) * price.inputPerMT) / 1_000_000 +
    (cached * cachedPrice) / 1_000_000 +
    (output * price.outputPerMT) / 1_000_000
  );
}

/**
 * Aggregate workspace statistics from persisted sessions. Sessions without
 * recorded usage still count toward session/status/message/tool-call totals
 * and recent activity, but contribute nothing to usage or cost.
 */
export function computeWorkspaceStats(sessions: readonly SessionRecord[]): WorkspaceStats {
  const statusCounts: Record<SessionStatus, number> = {
    active: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
  };
  const usage = emptyUsage();
  let sessionsWithUsage = 0;
  let totalMessages = 0;
  let totalToolCalls = 0;
  let last7Days = 0;
  let last30Days = 0;

  const now = Date.now();
  // Per-model accumulators; provider follows the most recently updated session.
  const byModel = new Map<string, { stat: ModelStat; lastUpdatedAt: string }>();
  const unknownModels = new Set<string>();

  for (const session of sessions) {
    statusCounts[session.status] += 1;
    totalMessages += session.messages.length;
    totalToolCalls += session.toolCalls.length;

    const ageMs = now - Date.parse(session.updatedAt);
    if (Number.isFinite(ageMs) && ageMs <= 30 * DAY_MS) {
      last30Days += 1;
      if (ageMs <= 7 * DAY_MS) last7Days += 1;
    }

    if (session.usage === undefined) continue;
    sessionsWithUsage += 1;
    addUsage(usage, session.usage);

    let entry = byModel.get(session.model);
    if (entry === undefined) {
      entry = {
        stat: {
          model: session.model,
          provider: session.provider,
          sessions: 0,
          usage: emptyUsage(),
          estimatedCostUsd: 0,
          priceMatched: false,
        },
        lastUpdatedAt: '',
      };
      byModel.set(session.model, entry);
    }
    entry.stat.sessions += 1;
    addUsage(entry.stat.usage, session.usage);
    if (session.updatedAt >= entry.lastUpdatedAt) {
      entry.lastUpdatedAt = session.updatedAt;
      entry.stat.provider = session.provider;
    }
    const price = lookupModelPrice(session.model);
    if (price === undefined) {
      unknownModels.add(session.model);
    } else {
      entry.stat.priceMatched = true;
      entry.stat.estimatedCostUsd += estimateCostUsd(session.usage, price);
    }
  }

  const byModelStats = [...byModel.values()]
    .map((entry) => entry.stat)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens || a.model.localeCompare(b.model));
  const estimatedCostUsd = byModelStats.reduce((sum, stat) => sum + stat.estimatedCostUsd, 0);

  return {
    totalSessions: sessions.length,
    sessionsWithUsage,
    statusCounts,
    usage,
    totalMessages,
    totalToolCalls,
    recent: { last7Days, last30Days },
    byModel: byModelStats,
    costUnknownModels: [...unknownModels].sort((a, b) => a.localeCompare(b)),
    estimatedCostUsd,
  };
}
