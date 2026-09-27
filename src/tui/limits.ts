import type { Language } from '../types.js';
import type { TuiLimitBucket, TuiLimitDashboard, TuiLimitWindow } from './types.js';

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const USAGE_REQUEST_TIMEOUT_MS = 10_000;

export type LimitProvider = 'codex' | 'opencode-go' | 'unsupported';

export function limitProviderFor(provider: string): LimitProvider {
  if (provider === 'codex' || provider === 'opencode-go') return provider;
  return 'unsupported';
}

export class OpenCodeGoUsageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: 'missing-key' | 'http' | 'invalid-response' = 'invalid-response',
  ) {
    super(message);
    this.name = 'OpenCodeGoUsageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function usageWindow(value: unknown, label: string): TuiLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = value.percent;
  const rateLimited = value.status === 'rate-limited';
  let usedPercent = 100;
  if (!rateLimited) {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
    usedPercent = percent;
  }

  const resetAt = typeof value.resetsAt === 'string' ? Date.parse(value.resetsAt) : Number.NaN;
  return {
    label,
    usedPercent,
    ...(Number.isFinite(resetAt) ? { resetsAt: resetAt / 1000 } : {}),
  };
}

export function parseOpenCodeGoUsage(payload: unknown, language: Language): TuiLimitDashboard {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    throw new OpenCodeGoUsageError('Invalid OpenCode Go usage response.');
  }

  const zh = language === 'zh-CN';
  const primary = usageWindow(payload.usage.rolling, zh ? '滚动 5 小时' : 'Rolling 5 hours');
  const secondary = usageWindow(payload.usage.weekly, zh ? '每周' : 'Weekly');
  const tertiary = usageWindow(payload.usage.monthly, zh ? '每月' : 'Monthly');
  if (primary === undefined && secondary === undefined && tertiary === undefined) {
    throw new OpenCodeGoUsageError('OpenCode Go usage response contains no valid windows.');
  }

  const bucket: TuiLimitBucket = {
    name: 'OpenCode Go',
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(tertiary === undefined ? {} : { tertiary }),
  };
  return {
    title: zh ? 'OpenCode Go 额度' : 'OpenCode Go quota',
    buckets: [bucket],
  };
}

export async function fetchOpenCodeGoLimitDashboard(
  apiKey: string | undefined,
  language: Language,
): Promise<TuiLimitDashboard> {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new OpenCodeGoUsageError(
      'OpenCode Go API key is not configured.',
      undefined,
      'missing-key',
    );
  }
  const response = await fetch(OPENCODE_GO_USAGE_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OpenCodeGoUsageError(
      `OpenCode Go usage request failed with HTTP ${String(response.status)}.`,
      response.status,
      'http',
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OpenCodeGoUsageError('OpenCode Go returned invalid JSON.');
  }
  return parseOpenCodeGoUsage(payload, language);
}
