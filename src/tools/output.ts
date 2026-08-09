import type { JsonValue, ToolResult } from '../types.js';
import { ToolError, toToolError } from './errors.js';

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

export function truncateUtf8(value: string, maximumBytes: number): TruncatedText {
  const source = Buffer.from(value, 'utf8');
  if (source.byteLength <= maximumBytes) {
    return { text: value, truncated: false, originalBytes: source.byteLength };
  }

  const suffix = '\n...[output truncated]';
  const suffixBytes = Buffer.byteLength(suffix);
  const limit = Math.max(0, maximumBytes - suffixBytes);
  let prefix = source.subarray(0, limit).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') > limit) {
    prefix = prefix.slice(0, -1);
  }

  return {
    text: `${prefix}${suffix}`,
    truncated: true,
    originalBytes: source.byteLength,
  };
}

export function successfulResult(
  callId: string,
  toolName: string,
  output: string,
  options: { data?: JsonValue; truncated?: boolean } = {},
): ToolResult {
  return {
    callId,
    toolName,
    success: true,
    output,
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
  };
}

export function failedResult(callId: string, toolName: string, error: unknown): ToolResult {
  const toolError = toToolError(error);
  return {
    callId,
    toolName,
    success: false,
    output: '',
    error: { code: toolError.code, message: toolError.message },
  };
}

export function invalidArgument(message: string): never {
  throw new ToolError('INVALID_ARGUMENT', message);
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidArgument('Tool arguments must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

/**
 * Some gateways stringify a JSON `null` argument into the literal text
 * "null" (or "undefined"); normalize those back to `null` so argument
 * parsers treat them as omitted instead of rejecting them as a wrong type
 * (which made tools like search_text and run_command fail mid-run).
 */
function normalizeNullText(value: unknown): unknown {
  if (typeof value === 'string' && (value === 'null' || value === 'undefined')) return null;
  return value;
}

export function optionalString(
  value: unknown,
  name: string,
  defaultValue?: string,
): string | undefined {
  const normalized = normalizeNullText(value);
  if (normalized === undefined || normalized === null) return defaultValue;
  if (typeof normalized !== 'string') invalidArgument(`${name} must be a string.`);
  return normalized;
}

export function requiredString(value: unknown, name: string): string {
  const result = optionalString(value, name);
  if (result === undefined || result.length === 0) {
    invalidArgument(`${name} is required and must be a non-empty string.`);
  }
  return result;
}

export function optionalBoolean(value: unknown, name: string, defaultValue: boolean): boolean {
  const normalized = normalizeNullText(value);
  if (normalized === undefined || normalized === null) return defaultValue;
  if (typeof normalized !== 'boolean') invalidArgument(`${name} must be a boolean.`);
  return normalized;
}

export function optionalInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = normalizeNullText(value);
  if (normalized === undefined || normalized === null) return defaultValue;
  if (
    !Number.isInteger(normalized) ||
    (normalized as number) < minimum ||
    (normalized as number) > maximum
  ) {
    invalidArgument(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return normalized as number;
}
