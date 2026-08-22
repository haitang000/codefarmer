import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { JsonObject, ToolDefinition, ToolResult } from '../types.js';
import { ToolError } from './errors.js';
import { optionalInteger, requiredString, successfulResult, truncateUtf8 } from './output.js';
import type { ResolvedToolContext } from './types.js';

const DEFAULT_MAX_FETCH_BYTES = 512 * 1024;
const MIN_FETCH_BYTES = 1024;
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Browser-like UA: some hosts reject a bare "CodeFarmer" identifier. */
export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 CodeFarmer/1.0';

const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/ld+json',
  'application/javascript',
  'application/x-javascript',
  'application/svg+xml',
  'application/x-yaml',
  'application/x-www-form-urlencoded',
  'application/toml',
]);

interface IpAddress {
  family: 4 | 6;
  value: bigint;
}

const IPV4_PRIVATE_RANGES: readonly { network: string; prefix: number }[] = [
  { network: '0.0.0.0', prefix: 8 },
  { network: '10.0.0.0', prefix: 8 },
  { network: '100.64.0.0', prefix: 10 },
  { network: '127.0.0.0', prefix: 8 },
  { network: '169.254.0.0', prefix: 16 },
  { network: '172.16.0.0', prefix: 12 },
  { network: '192.0.0.0', prefix: 24 },
  { network: '192.0.2.0', prefix: 24 },
  { network: '192.168.0.0', prefix: 16 },
  { network: '198.18.0.0', prefix: 15 },
  { network: '198.51.100.0', prefix: 24 },
  { network: '203.0.113.0', prefix: 24 },
  { network: '224.0.0.0', prefix: 4 },
  { network: '240.0.0.0', prefix: 4 },
];

const IPV6_PRIVATE_RANGES: readonly { network: bigint; prefix: number }[] = [
  { network: 0n, prefix: 128 }, // :: (unspecified)
  { network: 1n, prefix: 128 }, // ::1 (loopback)
  { network: 0xfc00_0000_0000_0000_0000_0000_0000_0000n, prefix: 7 }, // fc00::/7
  { network: 0xfe80_0000_0000_0000_0000_0000_0000_0000n, prefix: 10 }, // fe80::/10
  { network: 0xff00_0000_0000_0000_0000_0000_0000_0000n, prefix: 8 }, // ff00::/8
];

function parseIpv4(address: string): IpAddress | undefined {
  if (isIP(address) !== 4) return undefined;
  let value = 0n;
  for (const octet of address.split('.')) {
    value = (value << 8n) | BigInt(Number(octet));
  }
  return { family: 4, value };
}

function expandIpv6(address: string): string[] | undefined {
  const parts = address.split('::');
  if (parts.length > 2) return undefined;
  const first = parts[0] ?? '';
  const second = parts[1] ?? '';
  const left = first === '' ? [] : first.split(':');
  const right = parts.length === 2 && second !== '' ? second.split(':') : [];
  if (parts.length === 1) {
    // Full form without '::' carries exactly 8 groups; anything else is not
    // a valid address and must not be treated as a parseable public host.
    return left.length === 8 ? left : undefined;
  }
  if (left.length + right.length > 7) return undefined;
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8) return undefined;
  return groups;
}

function parseIpv6(address: string): IpAddress | undefined {
  if (isIP(address) !== 6) return undefined;
  const groups = expandIpv6(address);
  if (groups === undefined) return undefined;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return { family: 6, value };
}

function parseIp(address: string): IpAddress | undefined {
  return parseIpv4(address) ?? parseIpv6(address);
}

function ipv4InRange(value: bigint, network: string, prefix: number): boolean {
  let networkValue = 0n;
  for (const octet of network.split('.')) {
    networkValue = (networkValue << 8n) | BigInt(Number(octet));
  }
  const mask = prefix === 0 ? 0n : (~0n << BigInt(32 - prefix)) & 0xffff_ffffn;
  return (value & mask) === (networkValue & mask);
}

function isPrivateIpv6(value: bigint, network: bigint, prefix: number): boolean {
  const mask =
    prefix === 0 ? 0n : (~0n << BigInt(128 - prefix)) & 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn;
  return (value & mask) === (network & mask);
}

function isPrivateAddress(address: string): boolean {
  const ip = parseIp(address);
  if (ip === undefined) {
    // An address we cannot parse is treated as private so it is never fetched.
    return true;
  }
  if (ip.family === 4) {
    return IPV4_PRIVATE_RANGES.some((range) => ipv4InRange(ip.value, range.network, range.prefix));
  }
  return IPV6_PRIVATE_RANGES.some((range) => isPrivateIpv6(ip.value, range.network, range.prefix));
}

function blockedError(address: string): ToolError {
  return new ToolError(
    'WEB_FETCH_BLOCKED',
    `Fetching private or local addresses is not allowed: ${address}.`,
  );
}

export function parseFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError('INVALID_ARGUMENT', 'URL is not valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('INVALID_ARGUMENT', 'Only http:// and https:// URLs are allowed.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ToolError('INVALID_ARGUMENT', 'URLs with embedded credentials are not allowed.');
  }
  if (url.port !== '' && Number(url.port) === 0) {
    throw new ToolError('INVALID_ARGUMENT', 'URL port 0 is not allowed.');
  }
  return url;
}

export async function assertPublicHost(url: URL, allowPrivate: boolean): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (allowPrivate) return;
  if (parseIp(hostname) !== undefined) {
    if (isPrivateAddress(hostname)) throw blockedError(hostname);
    return;
  }
  let addresses: string[];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch {
    throw new ToolError('WEB_FETCH_BLOCKED', `Could not resolve host: ${hostname}.`);
  }
  const blocked = addresses.find((address) => isPrivateAddress(address));
  if (blocked !== undefined) {
    throw new ToolError(
      'WEB_FETCH_BLOCKED',
      `Host ${hostname} resolves to a private or local address (${blocked}) and is blocked.`,
    );
  }
}

function assertTextContentType(contentType: string | null): void {
  if (contentType === null || contentType === '') return;
  const type = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  if (type.startsWith('text/')) return;
  if (TEXT_CONTENT_TYPES.has(type)) return;
  throw new ToolError(
    'WEB_FETCH_CONTENT',
    `Unsupported content type "${contentType}": only text responses are returned.`,
  );
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ToolError('WEB_FETCH_CONTENT', 'Response is not valid UTF-8 text.');
  }
}

function decodeUtf8Prefix(buffer: Buffer): string {
  // A size cap can split a multi-byte character; replacement keeps the
  // already-downloaded prefix instead of failing the whole fetch.
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

function isHtmlContentType(contentType: string | null): boolean {
  const type = (contentType?.split(';', 1)[0] ?? '').trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/**
 * Turn fetched HTML into compact readable text so the model is not billed
 * for scripts, chrome, and tags. Plain text, JSON, and other types are left
 * alone by the caller.
 */
export function htmlToReadableText(html: string): string {
  let text = html;
  text = text.replace(/<script\b[\s\S]*?<\/script>/giu, '');
  text = text.replace(/<style\b[\s\S]*?<\/style>/giu, '');
  text = text.replace(/<noscript\b[\s\S]*?<\/noscript>/giu, '');
  text = text.replace(/<!--[\s\S]*?-->/gu, '');
  text = text.replace(/<br\s*\/?>/giu, '\n');
  text = text.replace(
    /<\/(p|div|h[1-6]|li|tr|section|article|header|footer|main|blockquote)[^>]*>/giu,
    '\n',
  );
  text = text.replace(/<li\b[^>]*>/giu, '- ');
  text = text.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu, '$2 ($1)');
  text = text.replace(/<[^>]+>/gu, '');
  text = text
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#0*39;|&#x27;/giu, "'");
  return text
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

export async function readBounded(
  response: Response,
  maximumBytes: number,
): Promise<{ text: string; overLimit: boolean }> {
  if (response.body === null) return { text: '', overLimit: false };
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    if (total + chunk.byteLength > maximumBytes) {
      await reader.cancel();
      const remaining = Math.max(0, maximumBytes - total);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return { text: decodeUtf8Prefix(Buffer.concat(chunks)), overLimit: true };
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return { text: decodeUtf8(Buffer.concat(chunks)), overLimit: false };
}

export const webFetchDefinition: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch an http(s) URL and return its text content. HTML is converted to readable text. Bounded in size and time; private, loopback, and link-local addresses are blocked.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
      maxBytes: {
        type: ['integer', 'null'],
        minimum: MIN_FETCH_BYTES,
        maximum: MAX_FETCH_BYTES,
        description: 'Optional response size cap in bytes (default 524288).',
      },
    },
    required: ['url', 'maxBytes'],
    additionalProperties: false,
  },
};

export async function webFetch(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
): Promise<ToolResult> {
  const rawUrl = requiredString(arguments_.url, 'url');
  const maxBytes = optionalInteger(
    arguments_.maxBytes,
    'maxBytes',
    DEFAULT_MAX_FETCH_BYTES,
    MIN_FETCH_BYTES,
    MAX_FETCH_BYTES,
  );
  const url = parseFetchUrl(rawUrl);
  await assertPublicHost(url, context.allowPrivateAddresses ?? false);

  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal =
    context.signal === undefined ? timeoutSignal : AbortSignal.any([context.signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: {
        accept: 'text/*, application/json, application/xml, application/javascript, */*;q=0.8',
        'user-agent': WEB_USER_AGENT,
      },
    });
  } catch (error) {
    if (
      context.signal?.aborted === true ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new ToolError('CANCELLED', 'The request was cancelled.');
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ToolError(
        'WEB_FETCH_TIMEOUT',
        `The request timed out after ${String(FETCH_TIMEOUT_MS)} ms.`,
      );
    }
    throw new ToolError(
      'WEB_FETCH_NETWORK',
      `Network error fetching ${rawUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.redirected) {
    await assertPublicHost(parseFetchUrl(response.url), context.allowPrivateAddresses ?? false);
  }

  const contentType = response.headers.get('content-type');
  assertTextContentType(contentType);
  const { text, overLimit } = await readBounded(response, maxBytes);
  const extractedHtml = isHtmlContentType(contentType);
  const readable = extractedHtml ? htmlToReadableText(text) : text;
  const finalUrl = response.redirected ? response.url : url.href;
  const truncated = truncateUtf8(readable, context.maxOutputBytes);
  const data: JsonObject = {
    url: finalUrl,
    status: response.status,
    contentType: contentType ?? '',
    size: truncated.originalBytes,
    ...(extractedHtml ? { extracted: true } : {}),
  };
  const output = overLimit
    ? `${truncated.text}\n...[response exceeded the ${String(maxBytes)} byte limit]`
    : truncated.text;
  return successfulResult(callId, 'web_fetch', output, {
    data,
    truncated: truncated.truncated || overLimit,
  });
}
