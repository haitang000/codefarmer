import { randomUUID } from 'node:crypto';

import { ConfigError, ProviderError } from '../infra/errors.js';
import type {
  AgentProvider,
  CodeFarmerConfig,
  ProviderInput,
  SessionMessage,
  SessionRecord,
  TokenUsage,
} from '../types.js';

/** Number of most recent messages kept verbatim after a compaction. */
export const COMPACT_KEEP_RECENT_MESSAGES = 1;
/**
 * Upper bound for the history sent to the summarising request. Tool outputs
 * already accumulated in `toolCalls.outputSummary` are also included, but the
 * oldest history is dropped first when the budget runs out.
 */
export const MAX_COMPACT_INPUT_CHARS = 120_000;
/** Upper bound for the generated summary stored as a system message. */
export const MAX_COMPACT_SUMMARY_CHARS = 8_000;
/**
 * TUI auto-hint threshold: suggest `/compact` once the conversation reaches
 * this many messages (stored-response chains are then long enough that
 * explicit-history replay would dominate the context window).
 */
export const COMPACT_HINT_MIN_MESSAGES = 24;
/**
 * TUI auto-hint threshold in characters of stored message content, so long
 * tool-heavy turns trigger the hint even with fewer messages.
 */
export const COMPACT_HINT_MIN_CHARS = 48_000;

const COMPACTION_INSTRUCTIONS = `You are compressing a long coding-agent conversation into one dense summary.

The conversation belongs to CodeFarmer, an agent that edits a workspace with tools (read_file, apply_patch, run_command, git tools, ...). The history below may contain user prompts, assistant replies, and a synthetic audit trail of tool calls.

Produce a single system-style summary that preserves, in order of importance:
- The user's goal, decided direction, and any explicit constraints or instructions that still apply.
- Every file created or modified, what changed in each, and why.
- Commands run and their outcomes, problems found, and remaining work or next steps.
- The most recent assistant reply almost verbatim, since it describes the current state of the task.

Rules:
- Write in the same language as the conversation (Chinese when the conversation is Chinese).
- Be concrete and specific (paths, commands, decisions); do not pad with generic filler.
- Output ONLY the summary text with no preamble, headings, or code fences.`;

interface CompactInput {
  input: ProviderInput[];
  totalChars: number;
}

/**
 * Build the summariser input from the session. History is walked newest-first
 * so budget trimming drops the oldest messages; the tool-call audit trail is
 * prepended as a reference document when it fits.
 */
function buildCompactionInput(session: SessionRecord, maximumChars: number): CompactInput {
  const messages = session.messages;
  const input: ProviderInput[] = [];
  let totalChars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined) continue;
    const item: ProviderInput = {
      type: 'message',
      role: message.role === 'system' ? 'system' : message.role,
      content: message.content,
    };
    const length = item.content.length;
    if (totalChars + length > maximumChars) {
      // A single oversized message would otherwise evict everything; keep its
      // head so the summariser still sees the topic.
      if (input.length === 0) {
        item.content = `${item.content.slice(0, maximumChars)}\n…[clipped for compaction]`;
        input.push(item);
        totalChars += item.content.length;
      }
      continue;
    }
    input.push(item);
    totalChars += length;
  }
  input.reverse();

  // Reference the audit trail so the summary preserves the actual work done
  // even when the corresponding messages were trimmed away.
  const toolLines: string[] = [];
  for (const call of session.toolCalls) {
    const raw =
      typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
    const argumentsText = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    const approval =
      call.approved === undefined ? '' : call.approved ? ' (approved)' : ' (denied)';
    const outcome = call.success ? 'ok' : 'failed';
    const output =
      call.outputSummary === undefined ? '' : ` — ${call.outputSummary.slice(0, 300)}`;
    toolLines.push(`${call.toolName}(${argumentsText}) ${outcome}${approval}${output}`);
  }
  if (toolLines.length > 0) {
    const toolText = `Audit trail of tool calls (oldest first):\n${toolLines.join('\n')}`;
    if (totalChars + toolText.length <= maximumChars) {
      input.unshift({ type: 'message', role: 'system', content: toolText });
      totalChars += toolText.length;
    }
  }
  return { input, totalChars };
}

/** Total characters of stored message content in a session. */
export function sessionContextChars(session: SessionRecord): number {
  return session.messages.reduce((sum, message) => sum + message.content.length, 0);
}

export interface CompactSessionOptions {
  session: SessionRecord;
  provider: AgentProvider;
  config: CodeFarmerConfig;
  keepRecentMessages?: number;
  signal?: AbortSignal;
}

export interface CompactResult {
  summary: string;
  /** Message count before the compaction. */
  originalMessageCount: number;
  /** Messages kept verbatim after the compaction (excluding the summary). */
  keptMessageCount: number;
  /** Messages replaced by the summary (original minus kept). */
  compressedMessageCount: number;
  usage: TokenUsage;
}

/**
 * Compress the early part of a session into a single `system` summary message
 * and keep the most recent turns verbatim. The stored-response chain is
 * cleared, so the next run replays "summary + recent turns" as explicit
 * history — the same code path that already keeps gateway compatibility.
 *
 * The session object is only mutated after the summary request succeeds; on
 * failure the session is left untouched.
 */
export async function compactSession(options: CompactSessionOptions): Promise<CompactResult> {
  const keepRecent = options.keepRecentMessages ?? COMPACT_KEEP_RECENT_MESSAGES;
  const session = options.session;
  const messages = session.messages;
  if (messages.length <= keepRecent + 1) {
    throw new ConfigError(
      `会话只有 ${String(messages.length)} 条消息，无需压缩` +
        `（保留最近 ${String(keepRecent)} 条时至少需要 ${String(keepRecent + 1)} 条）。`,
    );
  }

  const { input } = buildCompactionInput(session, MAX_COMPACT_INPUT_CHARS);
  let summary = '';
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const request = {
    model: options.config.model,
    reasoning: options.config.reasoning,
    verbosity: options.config.verbosity,
    reasoningSummary: options.config.reasoningSummary,
    instructions: COMPACTION_INSTRUCTIONS,
    input,
    tools: [],
    store: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  for await (const event of options.provider.stream(request)) {
    if (event.type === 'text_delta') summary += event.delta;
    if (event.type === 'response_completed') summary = event.outputText ?? summary;
    if (event.type === 'usage') {
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.totalTokens += event.usage.totalTokens;
    }
    if (event.type === 'error') {
      throw new ProviderError(event.error.message, {
        details: { providerCode: event.error.code },
        retryable: event.error.retryable,
      });
    }
  }
  summary = summary.trim();
  if (summary.length === 0) {
    throw new ProviderError('压缩请求未返回摘要内容，请重试。', { retryable: true });
  }
  if (summary.length > MAX_COMPACT_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_COMPACT_SUMMARY_CHARS - 1)}…`;
  }

  const originalCount = messages.length;
  const kept = messages.slice(-keepRecent);
  const summaryMessage: SessionMessage = {
    id: randomUUID(),
    role: 'system',
    content: `以下是本会话较早内容的压缩摘要（由 /compact 生成）：\n\n${summary}`,
    createdAt: new Date().toISOString(),
    compressed: true,
  };
  session.messages = [summaryMessage, ...kept];
  session.compactedAt = new Date().toISOString();
  // The stored-response chain would otherwise restart from the pre-compaction
  // conversation; clearing it forces explicit-history replay of the summary.
  delete session.previousResponseId;

  return {
    summary,
    originalMessageCount: originalCount,
    keptMessageCount: kept.length,
    compressedMessageCount: originalCount - kept.length,
    usage,
  };
}
