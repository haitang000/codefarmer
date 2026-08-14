import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../src/tools/registry.js';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-webfetch-'));
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

describe('web_fetch', () => {
  it('fetches text content when private addresses are allowed', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('hello from the fixture');
    });
    const registry = await createToolRegistry({
      workspace,
      allowPrivateAddresses: true,
    });
    const result = await registry.execute({
      callId: 'fetch-1',
      name: 'web_fetch',
      arguments: { url: `${baseUrl}/page`, maxBytes: null },
    });
    expect(result).toMatchObject({
      callId: 'fetch-1',
      toolName: 'web_fetch',
      success: true,
    });
    expect(result.output).toBe('hello from the fixture');
    expect(result.data).toMatchObject({
      url: `${baseUrl}/page`,
      status: 200,
      contentType: 'text/plain; charset=utf-8',
    });
  });

  it('blocks private and loopback addresses by default', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((_request, response) => response.end('nope'));
    const registry = await createToolRegistry({ workspace });
    const result = await registry.execute({
      callId: 'blocked-1',
      name: 'web_fetch',
      arguments: { url: baseUrl, maxBytes: null },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'WEB_FETCH_BLOCKED' });
    expect(result.error?.message).toContain('127.0.0.1');
  });

  it('follows redirects and reports the final URL', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((request, response) => {
      if (request.url === '/start') {
        response.statusCode = 302;
        response.setHeader('location', '/final');
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/plain');
      response.end('redirected content');
    });
    const registry = await createToolRegistry({
      workspace,
      allowPrivateAddresses: true,
    });
    const result = await registry.execute({
      callId: 'redirect-1',
      name: 'web_fetch',
      arguments: { url: `${baseUrl}/start`, maxBytes: null },
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('redirected content');
    expect(result.data).toMatchObject({ url: `${baseUrl}/final` });
  });

  it('rejects binary content types', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(Buffer.from([0, 1, 2, 3]));
    });
    const registry = await createToolRegistry({
      workspace,
      allowPrivateAddresses: true,
    });
    const result = await registry.execute({
      callId: 'binary-1',
      name: 'web_fetch',
      arguments: { url: baseUrl, maxBytes: null },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'WEB_FETCH_CONTENT' });
  });

  it('caps the response size and marks truncated output', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end('x'.repeat(4096));
    });
    const registry = await createToolRegistry({
      workspace,
      allowPrivateAddresses: true,
    });
    const result = await registry.execute({
      callId: 'cap-1',
      name: 'web_fetch',
      arguments: { url: baseUrl, maxBytes: 1024 },
    });
    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('...[response exceeded the 1024 byte limit]');
  });

  it('rejects invalid schemes and embedded credentials', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace });

    const badScheme = await registry.execute({
      callId: 'scheme-1',
      name: 'web_fetch',
      arguments: { url: 'ftp://example.com/file', maxBytes: null },
    });
    expect(badScheme).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGUMENT' },
    });

    const credentials = await registry.execute({
      callId: 'creds-1',
      name: 'web_fetch',
      arguments: { url: 'https://user:pass@example.com/', maxBytes: null },
    });
    expect(credentials).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('cancels an in-flight fetch when the abort signal fires', async () => {
    const workspace = await temporaryWorkspace();
    const baseUrl = await startServer((_request, response) => {
      setTimeout(() => {
        response.setHeader('content-type', 'text/plain');
        response.end('too late');
      }, 1_000);
    });
    const controller = new AbortController();
    const registry = await createToolRegistry({
      workspace,
      allowPrivateAddresses: true,
      signal: controller.signal,
    });
    const pending = registry.execute({
      callId: 'cancel-1',
      name: 'web_fetch',
      arguments: { url: baseUrl, maxBytes: null },
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'CANCELLED' });
  });

  it('does not block public IPv6 hosts, compressed or full form', async () => {
    const { assertPublicHost } = await import('../../src/tools/web-fetch.js');
    const fullForm = new URL('http://[2a03:2880:f134:83:face:b00c:0:25de]/');
    const compressed = new URL('http://[2606:4700:4700::1111]/');
    await expect(assertPublicHost(fullForm, false)).resolves.toBeUndefined();
    await expect(assertPublicHost(compressed, false)).resolves.toBeUndefined();
  });

  it('blocks loopback and unique-local IPv6 hosts', async () => {
    const { assertPublicHost } = await import('../../src/tools/web-fetch.js');
    const loopback = new URL('http://[::1]/');
    const uniqueLocal = new URL('http://[fc00::1]/');
    const linkLocal = new URL('http://[fe80::1]/');
    for (const url of [loopback, uniqueLocal, linkLocal]) {
      await expect(assertPublicHost(url, false)).rejects.toMatchObject({
        code: 'WEB_FETCH_BLOCKED',
      });
    }
  });
});
