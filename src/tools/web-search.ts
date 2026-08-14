import type { JsonObject, ToolDefinition, ToolResult } from '../types.js';
import { ToolError } from './errors.js';
import { optionalInteger, requiredString, successfulResult, truncateUtf8 } from './output.js';
import type { ResolvedToolContext } from './types.js';
import { assertPublicHost, parseFetchUrl, readBounded } from './web-fetch.js';

/**
 * DuckDuckGo HTML search endpoint: public, no API key, plain HTML results.
 * The HTML layout is scraped with the same tolerances as the endpoint itself;
 * if DuckDuckGo changes the markup, this tool degrades to "no results" rather
 * than crashing the agent loop.
 */
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_QUERY_CHARS = 200;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;

// Result links and snippet links both live inside `<div class="result ...">`
// blocks; each block carries one anchor of each class. Titles and snippets may
// contain nested tags (usually <b> highlights), so the body is captured raw
// and stripped afterwards.
const RESULT_ANCHOR =
  /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;
const SNIPPET_ANCHOR = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/giu;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, '')
    .replace(/<style[\s\S]*?<\/style>/giu, '')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#0*39;|&#x27;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Resolve a result href to an absolute http(s) URL, unwrapping DDG redirects. */
export function resolveResultUrl(rawHref: string): string | undefined {
  let href = rawHref.trim();
  const question = href.indexOf('?');
  if (question >= 0) {
    const params = new URLSearchParams(href.slice(question + 1));
    const uddg = params.get('uddg');
    if (uddg !== null && uddg.length > 0) href = uddg;
  }
  try {
    const url = new URL(href, SEARCH_ENDPOINT);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username !== '' || url.password !== '') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Pair each result title with the snippet that appears inside the same
 * result block (after the title, before the next result title).
 */
export function parseSearchResults(html: string, maximum: number): SearchResult[] {
  const anchors = [...html.matchAll(RESULT_ANCHOR)].map((match) => ({
    title: stripHtml(match[2] ?? ''),
    href: match[1] ?? '',
    start: match.index,
    end: match.index + match[0].length,
  }));
  const snippets = [...html.matchAll(SNIPPET_ANCHOR)].map((match) => ({
    text: stripHtml(match[1] ?? ''),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const results: SearchResult[] = [];
  for (let index = 0; index < anchors.length && results.length < maximum; index += 1) {
    const anchor = anchors[index];
    if (anchor === undefined || anchor.title.length === 0) continue;
    const url = resolveResultUrl(anchor.href);
    if (url === undefined) continue;
    const nextAnchorStart = anchors[index + 1]?.start ?? Number.MAX_SAFE_INTEGER;
    const snippet = snippets.find(
      (candidate) => candidate.start >= anchor.end && candidate.end <= nextAnchorStart,
    );
    results.push({ title: anchor.title, url, snippet: snippet?.text ?? '' });
  }
  return results;
}

function fetchError(error: unknown, rawUrl: string, context: ResolvedToolContext): ToolError {
  if (context.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
    return new ToolError('CANCELLED', 'The request was cancelled.');
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new ToolError(
      'WEB_SEARCH_TIMEOUT',
      `The search request timed out after ${String(SEARCH_TIMEOUT_MS)} ms.`,
    );
  }
  return new ToolError(
    'WEB_SEARCH_NETWORK',
    `Search request failed for ${rawUrl}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function fetchSearchHtml(query: string, context: ResolvedToolContext): Promise<string> {
  const endpoint = context.webSearchEndpoint ?? SEARCH_ENDPOINT;
  const url = parseFetchUrl(`${endpoint}?q=${encodeURIComponent(query)}`);
  await assertPublicHost(url, context.allowPrivateAddresses ?? false);

  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal =
    context.signal === undefined ? timeoutSignal : AbortSignal.any([context.signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: {
        accept: 'text/html, */*;q=0.8',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 CodeFarmer/1.0',
      },
    });
  } catch (error) {
    throw fetchError(error, url.href, context);
  }
  if (!response.ok) {
    throw new ToolError(
      'WEB_SEARCH_NETWORK',
      `Search endpoint returned HTTP ${String(response.status)} for ${url.href}.`,
    );
  }
  const { text, overLimit } = await readBounded(response, MAX_HTML_BYTES);
  if (overLimit) {
    throw new ToolError('WEB_SEARCH_NETWORK', 'Search response exceeded the size limit.');
  }
  return text;
}

export const webSearchDefinition: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web through DuckDuckGo and return result titles, URLs, and snippets. Use it to discover pages, then web_fetch for full content.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARS },
      maxResults: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: MAX_RESULTS,
        description: `Optional result count, 1-${String(MAX_RESULTS)} (default ${String(DEFAULT_MAX_RESULTS)}).`,
      },
    },
    required: ['query', 'maxResults'],
    additionalProperties: false,
  },
};

export async function webSearch(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
): Promise<ToolResult> {
  const query = requiredString(arguments_.query, 'query');
  const maxResults = optionalInteger(
    arguments_.maxResults,
    'maxResults',
    DEFAULT_MAX_RESULTS,
    1,
    MAX_RESULTS,
  );
  const html = await fetchSearchHtml(query, context);
  const results = parseSearchResults(html, maxResults);
  const data: JsonObject = {
    query,
    count: results.length,
    ...(context.webSearchEndpoint === undefined ? {} : { url: SEARCH_ENDPOINT }),
  };
  if (results.length === 0) {
    return successfulResult(
      callId,
      'web_search',
      `No search results for: ${query}. Rephrase the query or check the search endpoint.`,
      { data },
    );
  }
  const rendered = results
    .map(
      (result, index) =>
        `${String(index + 1)}. ${result.title}\n   ${result.url}` +
        (result.snippet.length === 0 ? '' : `\n   ${result.snippet}`),
    )
    .join('\n\n');
  const truncated = truncateUtf8(rendered, context.maxOutputBytes);
  return successfulResult(callId, 'web_search', truncated.text, {
    data: { ...data, truncated: truncated.truncated },
    truncated: truncated.truncated,
  });
}
