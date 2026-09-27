import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchOpenCodeGoLimitDashboard,
  limitProviderFor,
  OpenCodeGoUsageError,
  OPENCODE_GO_USAGE_URL,
  parseOpenCodeGoUsage,
} from '../src/tui/limits.js';

const usageResponse = {
  usage: {
    rolling: {
      status: 'ok',
      percent: 12,
      resetsAt: '2026-09-28T00:00:00.000Z',
    },
    weekly: {
      status: 'ok',
      percent: 34,
      resetsAt: '2026-10-04T00:00:00.000Z',
    },
    monthly: {
      status: 'ok',
      percent: 56,
      resetsAt: '2026-10-27T00:00:00.000Z',
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenCode Go limit lookup', () => {
  it('selects quota lookup by active provider', () => {
    expect(limitProviderFor('codex')).toBe('codex');
    expect(limitProviderFor('opencode-go')).toBe('opencode-go');
    expect(limitProviderFor('openai')).toBe('unsupported');
    expect(limitProviderFor('custom-endpoint')).toBe('unsupported');
  });

  it('parses all three windows, localizes labels, and converts reset timestamps', () => {
    const dashboard = parseOpenCodeGoUsage(usageResponse, 'zh-CN');

    expect(dashboard.title).toBe('OpenCode Go 额度');
    expect(dashboard.buckets).toEqual([
      {
        name: 'OpenCode Go',
        primary: {
          label: '滚动 5 小时',
          usedPercent: 12,
          resetsAt: Date.parse('2026-09-28T00:00:00.000Z') / 1000,
        },
        secondary: {
          label: '每周',
          usedPercent: 34,
          resetsAt: Date.parse('2026-10-04T00:00:00.000Z') / 1000,
        },
        tertiary: {
          label: '每月',
          usedPercent: 56,
          resetsAt: Date.parse('2026-10-27T00:00:00.000Z') / 1000,
        },
      },
    ]);
  });

  it('treats rate-limited windows as fully used and skips invalid windows', () => {
    const dashboard = parseOpenCodeGoUsage(
      {
        usage: {
          rolling: { status: 'rate-limited' },
          weekly: { status: 'ok', percent: Number.NaN },
          monthly: null,
        },
      },
      'en',
    );

    expect(dashboard.buckets[0]).toEqual({
      name: 'OpenCode Go',
      primary: { label: 'Rolling 5 hours', usedPercent: 100 },
    });
  });

  it('rejects malformed responses when no quota windows are usable', () => {
    expect(() => parseOpenCodeGoUsage({}, 'en')).toThrow(OpenCodeGoUsageError);
    expect(() => parseOpenCodeGoUsage({ usage: { rolling: { percent: '50' } } }, 'en')).toThrow(
      /no valid windows/i,
    );
  });

  it('requests the official endpoint with a bearer key and a bounded timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(usageResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const dashboard = await fetchOpenCodeGoLimitDashboard('go-api-key', 'en');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(OPENCODE_GO_USAGE_URL);
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer go-api-key',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(dashboard.buckets[0]?.tertiary?.label).toBe('Monthly');
  });

  it('does not make a request when the API key is missing', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOpenCodeGoLimitDashboard(undefined, 'en')).rejects.toMatchObject({
      kind: 'missing-key',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429])('reports HTTP %i from the usage endpoint', async (status) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })));

    await expect(fetchOpenCodeGoLimitDashboard('go-api-key', 'en')).rejects.toMatchObject({
      status,
      kind: 'http',
    });
  });

  it('reports network and invalid JSON responses as lookup failures', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
    await expect(fetchOpenCodeGoLimitDashboard('go-api-key', 'en')).rejects.toThrow('offline');

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('not-json', { status: 200 })),
    );
    await expect(fetchOpenCodeGoLimitDashboard('go-api-key', 'en')).rejects.toThrow(
      /invalid json/i,
    );
  });
});
