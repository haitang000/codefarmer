import { randomUUID } from 'node:crypto';

import { AuthenticationError, ProviderError, ToolError } from '../infra/errors.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolLifecycleHooks } from '../tools/types.js';
import type {
  AgentProvider,
  CodeFarmerConfig,
  ProviderEvent,
  ProviderInput,
  ProviderToolResultInput,
  SessionRecord,
  TokenUsage,
  SkillCatalog,
} from '../types.js';
import { buildAgentInstructions } from './prompt.js';
import type { AgentRunResult } from './runtime-types.js';
import { deriveSessionTitle, type SessionStore } from './session-store.js';
import {
  COMPACT_KEEP_RECENT_MESSAGES,
  compactSession,
  sessionContextChars,
  type CompactResult,
} from './session-compact.js';

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Number of attempts for one provider turn when the failure is retryable. */
const MAX_TURN_ATTEMPTS = 3;
/** Extra attempts when a turn finishes with neither text nor tool calls. */
const MAX_EMPTY_TURNS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
/**
 * Upper bound for the replay transcript sent to the model (explicit-history
 * mode). Without trimming, tool outputs accumulate every turn and quickly
 * overflow the model context window, turning a recoverable mode into a hard
 * "maximum context length" failure.
 */
const MAX_TRANSCRIPT_CHARS = 150_000;
/**
 * Upper bound for the tool outputs included in one request input. Several
 * parallel tools can each return tens of kilobytes; clamping keeps the
 * request inside the context window on the next turn.
 */
const MAX_TOOL_OUTPUT_INPUT_CHARS = 24_000;
/** Keep the title request cheap even when a resumed session is very long. */
const MAX_TITLE_INPUT_CHARS = 12_000;
const MAX_TITLE_LENGTH = 60;
/** DeepSeek can require long tool chains; its configured limit is a soft checkpoint. */
const DEEPSEEK_HARD_TURN_LIMIT = 100;

const TITLE_INSTRUCTIONS = `请根据提供的会话内容生成一个简洁、准确的会话标题。
要求：
- 只输出标题本身，不要前缀、引号、解释、Markdown 或句末标点；
- 使用会话主要使用的语言；
- 突出用户要完成的主要任务，控制在 60 个字符以内。`;

function cleanGeneratedTitle(value: string): string {
  let title = value.split(/\r?\n/u, 1)[0]?.trim() ?? '';
  title = title.replace(/^(标题|title)\s*[:：]\s*/iu, '');
  title = title.replace(/^[`"“”'‘’]+|[`"“”'‘’]+$/gu, '').trim();
  title = title.replace(/[。.!！?？；;]+$/u, '').trim();
  if (title.length === 0) return '';
  if (title.length <= MAX_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function titleInput(session: SessionRecord): ProviderInput[] {
  const input: ProviderInput[] = [];
  let remaining = MAX_TITLE_INPUT_CHARS;
  for (const message of session.messages) {
    if (remaining <= 0) break;
    const content = message.content.slice(0, remaining);
    input.push({ type: 'message', role: message.role, content });
    remaining -= content.length;
  }
  return input;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryableProviderFailure(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

function sumUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
  };
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Detect providers or gateways that cannot continue from a stored response
 * chain, for example endpoints that reject `previous_response_id` or reply
 * with "No tool call found for tool output" because they never stored the
 * response. Those failures are recoverable by replaying explicit history.
 */
function isChainUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no tool call found|previous_response_id|previous response|response.{0,60}(not found|does not exist|could not be found)/iu.test(
    message,
  );
}

function providerInputLength(item: ProviderInput): number {
  if (item.type === 'message') return item.content.length;
  if (item.type === 'function_call') return item.name.length + item.arguments.length;
  return item.output.length;
}

/**
 * Drop the oldest tool round-trips (function_call plus its outputs) until the
 * replay transcript fits the context budget. Only complete round-trips are
 * removed so call/output pairing stays valid for the gateway.
 */
function trimTranscript(transcript: ProviderInput[], maximumChars: number): void {
  let total = transcript.reduce((sum, item) => sum + providerInputLength(item), 0);
  if (total <= maximumChars) return;
  // Round-trips are always removed from the front, so after each removal the
  // next candidate sits at or after the removal index. Scanning forward from
  // there keeps the whole trim linear in the transcript size; re-scanning
  // from the start on every removal would make it quadratic.
  let firstCall = transcript.findIndex((item) => item.type === 'function_call');
  while (total > maximumChars) {
    if (firstCall < 0) break;
    // One turn can emit several parallel tool calls, stored as a run of
    // function_call items followed by a run of function_call_output items.
    // The whole batch must be dropped together: removing only part of it
    // leaves outputs whose call is gone, and gateways reject the replay with
    // "No tool call found for tool output".
    let end = firstCall;
    while (end < transcript.length && transcript[end]?.type === 'function_call') {
      end += 1;
    }
    while (end < transcript.length && transcript[end]?.type === 'function_call_output') {
      end += 1;
    }
    const removed = transcript.splice(firstCall, end - firstCall);
    total -= removed.reduce((sum, item) => sum + providerInputLength(item), 0);
    let next = firstCall;
    while (next < transcript.length && transcript[next]?.type !== 'function_call') {
      next += 1;
    }
    firstCall = next < transcript.length ? next : -1;
  }

  // A conversation can also overflow without any tool calls (for example,
  // repeated long user/assistant messages). Drop the oldest ordinary message
  // entries as a final fallback instead of sending an over-limit request that
  // DeepSeek will reject with HTTP 400.
  while (total > maximumChars) {
    const messageIndex = transcript.findIndex((item, index) => {
      if (item.type !== 'message') return false;
      // Keep the first message as the task anchor whenever possible.
      return index > 0;
    });
    if (messageIndex < 0) break;
    const [removed] = transcript.splice(messageIndex, 1);
    if (removed !== undefined) total -= providerInputLength(removed);
  }

  // If one message alone is larger than the budget, keep a bounded prefix so
  // the request remains valid and the model still sees the beginning of the
  // task/output for orientation.
  if (total > maximumChars) {
    const largestIndex = transcript.reduce(
      (largest, item, index) =>
        providerInputLength(item) > providerInputLength(transcript[largest] ?? item)
          ? index
          : largest,
      0,
    );
    const largest = transcript[largestIndex];
    if (largest?.type === 'message' || largest?.type === 'function_call_output') {
      const content = largest.type === 'message' ? largest.content : largest.output;
      const keep = Math.max(1, maximumChars - (total - content.length));
      const truncated =
        content.length <= keep
          ? content
          : `${content.slice(0, Math.max(1, keep - 24))}\n…[context truncated]`;
      transcript[largestIndex] =
        largest.type === 'message'
          ? { ...largest, content: truncated }
          : { ...largest, output: truncated };
    }
  }
}

/**
 * Clamp the combined size of tool outputs sent back to the model so a batch
 * of parallel calls does not overflow the context window on the next turn.
 * Outputs are trimmed proportionally, keeping the tail of each result.
 */
function clampToolOutputs(
  outputs: ProviderToolResultInput[],
  maximumChars: number,
): ProviderToolResultInput[] {
  let total = 0;
  for (const item of outputs) total += item.output.length;
  if (total <= maximumChars) return outputs;
  const ratio = maximumChars / total;
  return outputs.map((item) => {
    const cut = Math.max(0, Math.floor(item.output.length * ratio) - 20);
    if (cut >= item.output.length) return item;
    return {
      ...item,
      output: `${item.output.slice(0, cut)}\n…[output truncated for context]`,
    };
  });
}

function approvalState(
  toolName: string,
  result: AgentRunResult['toolCalls'][number]['result'],
): boolean | undefined {
  if (result.error?.code === 'APPROVAL_DENIED') return false;
  if (toolName === 'apply_patch' && result.success) return true;
  if (toolName === 'run_command' && result.data !== null && typeof result.data === 'object') {
    const classification = !Array.isArray(result.data) ? result.data.classification : undefined;
    if (
      classification !== null &&
      typeof classification === 'object' &&
      !Array.isArray(classification)
    ) {
      return classification.risk === 'mutating' ? true : undefined;
    }
  }
  return undefined;
}

function ephemeralSession(
  workspace: string,
  provider: string,
  model: string,
  baseURL: string,
): SessionRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    workspace,
    provider,
    model,
    baseURL,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    messages: [],
    toolCalls: [],
  };
}

export interface AgentRunnerOptions {
  provider: AgentProvider;
  tools: ToolRegistry;
  config: CodeFarmerConfig;
  workspace: string;
  sessionStore?: SessionStore;
  toolHooks?: ToolLifecycleHooks;
  skillCatalog?: SkillCatalog;
}

export interface RunTurnOptions {
  session?: SessionRecord;
  history?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: ProviderEvent) => void;
  toolHooks?: ToolLifecycleHooks;
  /** Plan mode: expose only read-only tools and reject any mutating call. */
  plan?: boolean;
  /** Auto mode: plan first, then execute ordinary operations without approval prompts. */
  auto?: boolean;
  /** Explicit skill references to load for this turn. */
  skills?: string[];
}

export class AgentRunner {
  public constructor(private readonly options: AgentRunnerOptions) {}

  /** Generate the title once, after the first assistant response is stored. */
  private async generateSessionTitle(session: SessionRecord, signal?: AbortSignal): Promise<void> {
    if (session.titleSource !== 'automatic' || session.titleGenerated === true) return;
    const input = titleInput(session);
    if (input.length === 0) return;
    try {
      let generated = '';
      let completed = '';
      let hasToolCall = false;
      for await (const event of this.options.provider.stream({
        model: this.options.config.model,
        reasoning: 'none',
        verbosity: 'low',
        reasoningSummary: 'none',
        maxOutputTokens: 128,
        instructions: TITLE_INSTRUCTIONS,
        input,
        store: false,
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (event.type === 'text_delta') generated += event.delta;
        if (event.type === 'tool_call') hasToolCall = true;
        if (event.type === 'response_completed') completed = event.outputText ?? generated;
        if (event.type === 'error') return;
      }
      const title = cleanGeneratedTitle(completed || generated);
      if (hasToolCall || title.length === 0) return;
      session.title = title;
      session.titleSource = 'automatic';
      session.titleGenerated = true;
    } catch {
      // Title generation is an enhancement; a provider failure must not fail
      // an otherwise completed coding task.
    }
  }

  public async run(prompt: string, runOptions: RunTurnOptions = {}): Promise<AgentRunResult> {
    const history = runOptions.history ?? true;
    const store = history ? this.options.sessionStore : undefined;
    const session =
      runOptions.session ??
      (store === undefined
        ? ephemeralSession(
            this.options.workspace,
            this.options.provider.name,
            this.options.config.model,
            this.options.config.baseURL,
          )
        : await store.createSession(
            this.options.provider.name,
            this.options.config.model,
            this.options.config.baseURL,
          ));

    // Auto-compact: when a persisted session has grown large, fold the early
    // part into a summary before this turn so the request stays small. The new
    // prompt is added afterwards, so it is never part of the summarised span.
    if (
      this.options.config.autoCompact &&
      session.messages.length > COMPACT_KEEP_RECENT_MESSAGES + 1 &&
      (session.messages.length >= this.options.config.autoCompactMinMessages ||
        sessionContextChars(session) >= this.options.config.autoCompactMinChars)
    ) {
      try {
        const beforeMessages = session.messages.length;
        const beforeChars = sessionContextChars(session);
        const result = await compactSession({
          session,
          provider: this.options.provider,
          config: this.options.config,
          ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
        });
        if (store !== undefined) {
          store.saveQueued(session);
          await store.flush().catch(() => undefined);
        }
        runOptions.onEvent?.({
          type: 'compacted',
          message:
            `自动压缩上下文：${String(result.compressedMessageCount)} 条早期消息折叠为摘要` +
            `（${String(result.summary.length)} 字符），保留最近 ${String(result.keptMessageCount)} 条；` +
            `上下文由约 ${String(beforeMessages)} 条消息 / ${String(beforeChars)} 字符降至 ` +
            `约 ${String(session.messages.length)} 条 / ${String(sessionContextChars(session))} 字符。`,
        });
      } catch {
        // Auto-compaction is an optimisation; a provider failure must not fail
        // the coding turn. The user can still run /compact manually.
      }
    }

    session.status = 'active';
    session.messages.push({
      id: randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
    });
    if (session.title === undefined) {
      session.title = deriveSessionTitle(prompt);
      session.titleSource = 'automatic';
    }
    if (store !== undefined) store.saveQueued(session);

    let previousResponseId = session.previousResponseId;
    let totalUsage = { ...EMPTY_USAGE };
    let finalMessage = '';
    const toolCalls: AgentRunResult['toolCalls'] = [];

    // Explicit replay transcript for gateways without stored-response chaining.
    let explicitHistory = this.options.provider.supportsResponseContinuation === false;
    const transcript: ProviderInput[] = [{ type: 'message', role: 'user', content: prompt }];
    if (previousResponseId === undefined && session.messages.length > 1) {
      explicitHistory = true;
      transcript.unshift(
        ...session.messages.slice(0, -1).map((message) => ({
          type: 'message' as const,
          role: message.role,
          content: message.content,
        })),
      );
    }
    let lastOutputs: ProviderToolResultInput[] | undefined;
    let emptyTurns = 0;
    // Agent instructions depend only on run-level settings, so render them
    // once instead of rebuilding the same string on every turn (including the
    // final summary request).
    const skillCatalog = this.options.skillCatalog;
    const selectedSkills =
      runOptions.skills === undefined || skillCatalog === undefined
        ? []
        : await Promise.all(runOptions.skills.map((ref) => skillCatalog.read(ref)));
    const instructions = buildAgentInstructions({
      workspace: this.options.workspace,
      approval: this.options.config.approval,
      language: this.options.config.language,
      ...(this.options.skillCatalog === undefined ? {} : { skills: this.options.skillCatalog }),
      ...(selectedSkills.length === 0 ? {} : { selectedSkills }),
      ...(runOptions.plan === true ? { plan: true } : {}),
      ...(runOptions.auto === true ? { auto: true } : {}),
    });

    try {
      const configuredTurnLimit = this.options.config.maxAgentTurns;
      const canExtendDeepSeekTurns = this.options.provider.name === 'deepseek';
      const turnLimit = canExtendDeepSeekTurns ? DEEPSEEK_HARD_TURN_LIMIT : configuredTurnLimit;
      for (let turn = 0; turn < turnLimit; turn += 1) {
        if (canExtendDeepSeekTurns && turn > 0 && turn % configuredTurnLimit === 0) {
          runOptions.onEvent?.({
            type: 'text_delta',
            delta: `\n[DeepSeek tool budget extended from ${String(turn)} to ${String(Math.min(turnLimit, turn + configuredTurnLimit))} rounds; continuing the task]\n`,
          });
        }
        const pendingCalls: { callId: string; name: string; arguments: string }[] = [];
        let responseId: string | undefined;
        let finishReason: string | undefined;
        let streamedText = '';
        let streamedReasoning = '';
        let completedText = '';
        const input: string | ProviderInput[] = explicitHistory
          ? [...transcript]
          : (lastOutputs ?? prompt);
        const request = {
          model: this.options.config.model,
          reasoning: this.options.config.reasoning,
          verbosity: this.options.config.verbosity,
          reasoningSummary: this.options.config.reasoningSummary,
          instructions,
          input,
          tools:
            runOptions.plan === true
              ? this.options.tools.readOnlyDefinitions
              : this.options.tools.definitions,
          store: this.options.config.store,
          ...(previousResponseId === undefined ? {} : { previousResponseId }),
          ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
        };

        let chainFailed = false;
        for (let attempt = 1; ; attempt += 1) {
          streamedText = '';
          streamedReasoning = '';
          completedText = '';
          pendingCalls.length = 0;
          responseId = undefined;
          finishReason = undefined;
          const usageBeforeAttempt = { ...totalUsage };
          try {
            for await (const event of this.options.provider.stream(request)) {
              runOptions.onEvent?.(event);
              if (event.type === 'text_delta') streamedText += event.delta;
              if (event.type === 'reasoning_delta') streamedReasoning += event.delta;
              if (event.type === 'tool_call') pendingCalls.push(event.call);
              if (event.type === 'usage') totalUsage = sumUsage(totalUsage, event.usage);
              if (event.type === 'response_completed') {
                responseId = event.responseId;
                completedText = event.outputText ?? '';
                finishReason = event.finishReason;
              }
              if (event.type === 'error') {
                if (/auth|api.?key|401/iu.test(event.error.code)) {
                  throw new AuthenticationError(event.error.message, {
                    details: { providerCode: event.error.code },
                  });
                }
                throw new ProviderError(event.error.message, {
                  details: { providerCode: event.error.code },
                  retryable: event.error.retryable,
                });
              }
            }
            break;
          } catch (error) {
            if (!explicitHistory && isChainUnsupportedError(error)) {
              chainFailed = true;
              break;
            }
            // Transient provider failures (rate limits, 5xx, dropped
            // connections) should not kill a long agent run; retry the same
            // turn a few times with backoff before surfacing the error.
            if (isRetryableProviderFailure(error) && attempt < MAX_TURN_ATTEMPTS) {
              totalUsage = usageBeforeAttempt;
              const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
              runOptions.onEvent?.({
                type: 'text_delta',
                delta: `\n[provider retry ${String(attempt)}/${String(MAX_TURN_ATTEMPTS - 1)} after ${String(delayMs)}ms: ${error instanceof Error ? error.message : String(error)}]\n`,
              });
              await sleep(delayMs, runOptions.signal);
              continue;
            }
            // Last resort: the turn relied on a stored-response chain, so any
            // failure (unmatched gateway error text, exhausted retries) is
            // recoverable by replaying explicit history once before giving up.
            if (!explicitHistory && previousResponseId !== undefined) {
              chainFailed = true;
              break;
            }
            throw error;
          }
        }
        if (chainFailed) {
          // The endpoint cannot resume from a stored response; replay explicit
          // history instead and keep the session off the broken chain.
          explicitHistory = true;
          previousResponseId = undefined;
          delete session.previousResponseId;
          const replay: ProviderInput[] = [
            ...session.messages.slice(0, -1).map((message) => ({
              type: 'message' as const,
              role: message.role,
              content: message.content,
            })),
            { type: 'message', role: 'user', content: prompt },
            ...transcript.slice(1),
          ];
          transcript.splice(0, transcript.length, ...replay);
          turn -= 1;
          continue;
        }

        if (responseId === undefined) {
          // Some gateways/proxies end the stream without a response.completed
          // event even though the turn produced text or tool calls. That must
          // not kill a long task: drop the stored-response chain and replay
          // explicit history on the next turn instead of aborting.
          explicitHistory = true;
          previousResponseId = undefined;
          delete session.previousResponseId;
        } else if (!explicitHistory) {
          // Explicit-history mode replays the full transcript on every turn,
          // so the stored-response chain must stay off: re-arming it would
          // duplicate the transcript against the stored chain, and gateways
          // that never stored the response (the reason explicit mode was
          // activated) fail again with an unrecoverable 400.
          previousResponseId = responseId;
          session.previousResponseId = responseId;
        }

        if (pendingCalls.length === 0) {
          finalMessage = completedText || streamedText;
          if (finalMessage.trim() === '') {
            if (finishReason !== undefined && finishReason !== 'completed') {
              throw new ProviderError(
                `模型在生成正文前停止（状态：${finishReason}）。请降低 reasoning 后再试。`,
                { retryable: false, details: { finishReason } },
              );
            }
            // An empty response almost always comes from the gateway or the
            // model stopping early; retry before surfacing a hard error so
            // the user is never left with a silent "completed" run.
            emptyTurns += 1;
            if (emptyTurns < MAX_EMPTY_TURNS) {
              const delayMs = RETRY_BASE_DELAY_MS * emptyTurns;
              runOptions.onEvent?.({
                type: 'text_delta',
                delta: `\n[empty response ${String(emptyTurns)}/${String(MAX_EMPTY_TURNS - 1)}, retrying after ${String(delayMs)}ms]\n`,
              });
              await sleep(delayMs, runOptions.signal);
              if (!explicitHistory) previousResponseId = responseId;
              turn -= 1;
              continue;
            }
            throw new ProviderError(
              '模型连续返回空响应（没有文字也没有工具调用）。通常是网关中断、上游限流或模型提前停止导致；请重试，或更换模型/网关后再继续。',
              { retryable: true, details: { finishReason: finishReason ?? null } },
            );
          }
          emptyTurns = 0;
          if (finishReason !== undefined && finishReason !== 'completed') {
            finalMessage += `\n\n[注意] 本轮响应未正常完成（状态：${finishReason}），以上内容可能不完整，请核对后再继续。`;
          }
          session.messages.push({
            id: randomUUID(),
            role: 'assistant',
            content: finalMessage,
            createdAt: new Date().toISOString(),
            ...(responseId === undefined ? {} : { responseId }),
          });
          if (store !== undefined) await this.generateSessionTitle(session, runOptions.signal);
          session.status = 'completed';
          session.usage = totalUsage;
          if (store !== undefined) {
            store.saveQueued(session);
            await store.flush().catch(() => undefined);
          }
          return {
            sessionId: session.id,
            status: 'completed',
            message: finalMessage,
            ...(responseId === undefined ? {} : { responseId }),
            toolCalls,
            usage: totalUsage,
          };
        }

        const toolHooks = runOptions.toolHooks ?? this.options.toolHooks;
        const results = await this.options.tools.executeMany(pendingCalls, {
          ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
          ...(toolHooks === undefined ? {} : { hooks: toolHooks }),
          ...(runOptions.plan === true ? { plan: true } : {}),
          ...(runOptions.auto === true ? { autoApprove: true } : {}),
        });
        for (const call of pendingCalls) {
          transcript.push({
            type: 'function_call',
            callId: call.callId,
            name: call.name,
            arguments: call.arguments,
            ...(streamedReasoning.length === 0 ? {} : { reasoningContent: streamedReasoning }),
          });
        }
        lastOutputs = results.map(({ result }) => ({
          type: 'function_call_output' as const,
          callId: result.callId,
          output: JSON.stringify({
            success: result.success,
            output: result.output,
            ...(result.data === undefined ? {} : { data: result.data }),
            ...(result.error === undefined ? {} : { error: result.error }),
            ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
          }),
        }));
        // Keep both the replay transcript and the next request inside the
        // context window: without clamping, long tool chains overflow it and
        // fail the run with a context-length error.
        lastOutputs = clampToolOutputs(lastOutputs, MAX_TOOL_OUTPUT_INPUT_CHARS);
        transcript.push(...lastOutputs);
        trimTranscript(transcript, MAX_TRANSCRIPT_CHARS);

        const now = new Date().toISOString();
        // Index the batch once: with several parallel tool calls, a linear
        // scan per call would make this bookkeeping quadratic in batch size.
        const resultsByCallId = new Map(results.map(({ callId, result }) => [callId, result]));
        for (const call of pendingCalls) {
          const result = resultsByCallId.get(call.callId);
          if (result === undefined) throw new ToolError(`工具未返回结果: ${call.name}`);
          const parsedArguments = parseArguments(call.arguments);
          const approved = approvalState(call.name, result);
          toolCalls.push({
            id: call.callId,
            name: call.name,
            arguments: parsedArguments,
            result,
          });
          session.toolCalls.push({
            callId: call.callId,
            toolName: call.name,
            arguments:
              typeof parsedArguments === 'object' && parsedArguments !== null
                ? (parsedArguments as never)
                : String(parsedArguments),
            success: result.success,
            ...(approved === undefined ? {} : { approved }),
            outputSummary: this.options.tools.isReadOnly(call.name)
              ? result.success
                ? 'read-only tool completed'
                : (result.error?.message ?? 'read-only tool failed')
              : result.output.slice(0, 1000),
            ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
            startedAt: now,
            completedAt: new Date().toISOString(),
          });
        }
        if (store !== undefined) store.saveQueued(session);
      }

      // Non-DeepSeek providers keep the configured limit strict. DeepSeek gets
      // here only after its automatic budget extensions reach the hard cap.
      const exhaustedTurnLimit = turnLimit;
      const summaryInstruction =
        `已达到最大工具轮次 ${String(exhaustedTurnLimit)}，不能再调用任何工具。` +
        '请简要总结已完成的修改、未完成事项、失败原因和下一步。';
      const summaryMessage: ProviderInput = {
        type: 'message',
        role: 'user',
        content: summaryInstruction,
      };

      let summaryText = '';
      let summaryResponseId: string | undefined;
      let summaryToolCall = false;
      const summaryInput: ProviderInput[] = explicitHistory
        ? [...transcript, summaryMessage]
        : [...(lastOutputs ?? []), summaryMessage];
      const summaryRequest = {
        model: this.options.config.model,
        reasoning: this.options.config.reasoning,
        verbosity: this.options.config.verbosity,
        reasoningSummary: this.options.config.reasoningSummary,
        instructions,
        input: summaryInput,
        tools: [],
        store: this.options.config.store,
        ...(previousResponseId === undefined ? {} : { previousResponseId }),
        ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
      };
      try {
        for await (const event of this.options.provider.stream(summaryRequest)) {
          runOptions.onEvent?.(event);
          if (event.type === 'text_delta') summaryText += event.delta;
          if (event.type === 'tool_call') summaryToolCall = true;
          if (event.type === 'usage') totalUsage = sumUsage(totalUsage, event.usage);
          if (event.type === 'response_completed') {
            summaryResponseId = event.responseId;
            summaryText = event.outputText ?? summaryText;
          }
          if (event.type === 'error') {
            if (/auth|api.?key|401/iu.test(event.error.code)) {
              throw new AuthenticationError(event.error.message, {
                details: { providerCode: event.error.code },
              });
            }
            throw new ProviderError(event.error.message, {
              details: { providerCode: event.error.code },
              retryable: event.error.retryable,
            });
          }
        }
      } catch (error) {
        if (error instanceof AuthenticationError) throw error;
      }

      if (summaryResponseId === undefined || summaryToolCall || summaryText.trim() === '') {
        // The final summary call failed (context limits, gateway issues). Do
        // not throw away the whole run: report what was actually done.
        const succeeded = toolCalls.filter((call) => call.result.success).length;
        finalMessage =
          `已达到最大工具轮次 ${String(exhaustedTurnLimit)}，且收尾总结请求未能完成` +
          (summaryToolCall
            ? '（模型仍尝试调用工具）'
            : summaryText.trim() === ''
              ? '（无输出）'
              : '（网关未返回完成事件）') +
          `。本次已执行 ${String(toolCalls.length)} 次工具调用，其中 ${String(succeeded)} 次成功。` +
          '建议将任务拆小后重新提交，或在新会话中继续。';
        session.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: finalMessage,
          createdAt: new Date().toISOString(),
        });
        if (store !== undefined) await this.generateSessionTitle(session, runOptions.signal);
        session.status = 'completed';
        session.usage = totalUsage;
        if (store !== undefined) {
          store.saveQueued(session);
          await store.flush().catch(() => undefined);
        }
        return {
          sessionId: session.id,
          status: 'completed',
          message: finalMessage,
          toolCalls,
          usage: totalUsage,
        };
      }

      finalMessage = summaryText;
      previousResponseId = summaryResponseId;
      // Keep resumed sessions off the stored-response chain when this run
      // already had to degrade to explicit history replay.
      if (!explicitHistory) session.previousResponseId = summaryResponseId;
      session.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: finalMessage,
        createdAt: new Date().toISOString(),
        responseId: summaryResponseId,
      });
      if (store !== undefined) await this.generateSessionTitle(session, runOptions.signal);
      session.status = 'completed';
      session.usage = totalUsage;
      if (store !== undefined) {
        store.saveQueued(session);
        await store.flush().catch(() => undefined);
      }
      return {
        sessionId: session.id,
        status: 'completed',
        message: finalMessage,
        responseId: summaryResponseId,
        toolCalls,
        usage: totalUsage,
      };
    } catch (error) {
      const cancelled = runOptions.signal?.aborted === true;
      session.status = cancelled ? 'cancelled' : 'failed';
      session.usage = totalUsage;
      session.error = {
        code: cancelled ? 'INTERRUPTED' : error instanceof Error ? error.name : 'UNKNOWN_ERROR',
        message: error instanceof Error ? error.message : String(error),
      };
      if (store !== undefined) {
        store.saveQueued(session);
        await store.flush().catch(() => undefined);
      }
      if (cancelled) {
        return {
          sessionId: session.id,
          status: 'cancelled',
          message: '',
          toolCalls,
          usage: totalUsage,
          error: session.error,
        };
      }
      throw error;
    }
  }

  /**
   * Compress the early part of the conversation into a summary `system`
   * message and keep only the most recent turns verbatim. The stored-response
   * chain is cleared, so the next `run` replays "summary + recent turns" as
   * explicit history — the same path that keeps gateway compatibility — and
   * every subsequent turn consumes far less context.
   *
   * The session is only mutated after the summary request succeeds.
   */
  public async compact(
    session: SessionRecord,
    options: { signal?: AbortSignal } = {},
  ): Promise<CompactResult> {
    const result = await compactSession({
      session,
      provider: this.options.provider,
      config: this.options.config,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const store = this.options.sessionStore;
    if (store !== undefined) {
      store.saveQueued(session);
      await store.flush().catch(() => undefined);
    }
    return result;
  }
}
