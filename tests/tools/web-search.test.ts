import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../src/tools/registry.js';
import { parseSearchResults, resolveResultUrl } from '../../src/tools/web-search.js';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-websearch-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await Promise.all([
    ...temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  ]);
});

const RESULTS_HTML = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc123">Example <b>Docs</b></a>
  </h2>
  <div class="result__snippet">
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=about%3Ablank&amp;rut=x">Snippet text &amp; more</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="https://plain.example.org/page">Plain link</a>
</div>
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.example.com%2F&amp;rut=z">Third result</a>
</div>
</body></html>
`;

describe('web_search result parsing', () => {
  it('unwraps DuckDuckGo redirect links and strips HTML', () => {
    expect(
      resolveResultUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc'),
    ).toBe('https://example.com/docs');
    expect(resolveResultUrl('https://plain.example.org/page')).toBe(
      'https://plain.example.org/page',
    );
    expect(resolveResultUrl('ftp://example.com/file')).toBeUndefined();
    expect(resolveResultUrl('https://user:pass@example.com/')).toBeUndefined();
  });

  it('pairs titles with snippets inside the same result block', () => {
    const results = parseSearchResults(RESULTS_HTML, 5);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: 'Example Docs',
      url: 'https://example.com/docs',
      snippet: 'Snippet text & more',
    });
    expect(results[1]).toEqual({
      title: 'Plain link',
      url: 'https://plain.example.org/page',
      snippet: '',
    });
  });

  it('respects the requested result count', () => {
    expect(parseSearchResults(RESULTS_HTML, 2)).toHaveLength(2);
    expect(parseSearchResults('<html>no results</html>', 5)).toEqual([]);
  });
});

describe('web_search tool', () => {
  it('returns search results through the configured endpoint', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(RESULTS_HTML);
    });
    const registry = await createToolRegistry({
      workspace,
      webSearchEndpoint: baseUrl,
      allowPrivateAddresses: true,
    });

    const result = await registry.execute({
      callId: 'search-1',
      name: 'web_search',
      arguments: { query: 'codefarmer docs', maxResults: 5 },
    });

    expect(result).toMatchObject({ callId: 'search-1', toolName: 'web_search', success: true });
    expect(result.output).toContain('1. Example Docs');
    expect(result.output).toContain('https://example.com/docs');
    expect(result.output).toContain('Snippet text & more');
    expect(result.data).toMatchObject({ query: 'codefarmer docs', count: 3 });
  });

  it('retries with POST when GET returns no parseable results', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.method === 'POST') {
        response.end(RESULTS_HTML);
        return;
      }
      response.end('<html><body>If you are not a robot, enable JavaScript.</body></html>');
    });
    const registry = await createToolRegistry({
      workspace,
      webSearchEndpoint: baseUrl,
      allowPrivateAddresses: true,
    });

    const result = await registry.execute({
      callId: 'search-post',
      name: 'web_search',
      arguments: { query: 'codefarmer docs', maxResults: 5 },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('1. Example Docs');
    expect(result.data).toMatchObject({ query: 'codefarmer docs', count: 3 });
  });

  it('reports an empty result set without failing', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<html><body>No results.</body></html>');
    });
    const registry = await createToolRegistry({
      workspace,
      webSearchEndpoint: baseUrl,
      allowPrivateAddresses: true,
    });

    const result = await registry.execute({
      callId: 'search-empty',
      name: 'web_search',
      arguments: { query: 'zzz', maxResults: null },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('No search results');
    expect(result.data).toMatchObject({ count: 0 });
  });

  it('blocks private endpoints by default like web_fetch', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((_request, response) => response.end('<html>hi</html>'));
    const registry = await createToolRegistry({ workspace, webSearchEndpoint: baseUrl });

    const result = await registry.execute({
      callId: 'search-blocked',
      name: 'web_search',
      arguments: { query: 'test', maxResults: null },
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'WEB_FETCH_BLOCKED' },
    });
  });

  it('rejects a missing query and caps the result count', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({
      workspace,
      webSearchEndpoint: 'https://example.com',
    });

    const missing = await registry.execute({
      callId: 'search-args',
      name: 'web_search',
      arguments: {},
    });
    expect(missing).toMatchObject({ success: false, error: { code: 'INVALID_ARGUMENT' } });
  });
});
