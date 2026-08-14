export type ApprovalPolicy = 'ask' | 'auto' | 'read-only';

export const PROVIDER_IDS = ['openai', 'gemini', 'grok', 'deepseek', 'kimi', 'opencode-go'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * 用户自定义的 OpenAI 兼容 API 端点（自定义 Provider）。在配置的
 * `customEndpoints` 中声明后，可通过 `provider` 字段引用其 `id`。
 */
export interface CustomEndpoint {
  /** 唯一标识，用于 `provider` 字段；不能与内置 Provider 重名。 */
  id: string;
  /** 可选显示名称；默认与 `id` 相同。 */
  label?: string;
  /** OpenAI 兼容 API Base URL（不含凭据、查询参数或片段）。 */
  baseURL: string;
  /** 该端点默认使用的模型。 */
  model: string;
  /**
   * 可选的 API Key 环境变量名；未设置时依次回退到
   * `CODEFARMER_API_KEY` 与本地凭据文件。
   */
  apiKeyEnv?: string;
  /**
   * 本地端点（如 Ollama、vLLM）可设为 true 以跳过 API Key 检查；
   * 请求仍会携带占位 Bearer 令牌。
   */
  apiKeyOptional?: boolean;
}

/**
 * 内联在配置 `provider` 字段中的自定义端点定义。与 `customEndpoints`
 * 中的条目一致，但 `id` 可选：缺省时由 `baseURL` 的主机名推导。
 */
export type CustomEndpointInput = Omit<CustomEndpoint, 'id'> & { id?: string };

// 'auto' 表示不下发 effort，由模型自行决定思考深度。
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TextVerbosity = 'low' | 'medium' | 'high';
export type ReasoningSummary = 'none' | 'auto' | 'concise' | 'detailed';

export const LANGUAGE_IDS = ['en', 'zh-CN'] as const;
export type Language = (typeof LANGUAGE_IDS)[number];

/** Accept common aliases used by the CLI and interactive command. */
export function normaliseLanguage(value: string): Language | undefined {
  const normalised = value.trim().toLowerCase().replace('_', '-');
  if (normalised === 'en' || normalised === 'english' || normalised === '英文') return 'en';
  if (
    normalised === 'zh' ||
    normalised === 'zh-cn' ||
    normalised === 'chinese' ||
    normalised === '中文' ||
    normalised === '简体中文'
  ) {
    return 'zh-CN';
  }
  return undefined;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface CodeFarmerConfig {
  language: Language;
  /** 内置 Provider（openai、gemini、grok、deepseek、kimi、opencode-go）或 customEndpoints 中定义的端点 id。 */
  provider: string;
  model: string;
  baseURL: string;
  /** 用户自定义的 OpenAI 兼容 API 端点列表。 */
  customEndpoints: CustomEndpoint[];
  reasoning: ReasoningEffort;
  verbosity: TextVerbosity;
  reasoningSummary: ReasoningSummary;
  approval: ApprovalPolicy;
  stream: boolean;
  store: true;
  logLevel: LogLevel;
  maxAgentTurns: number;
  maxFileSizeBytes: number;
  maxToolOutputBytes: number;
  commandTimeoutMs: number;
  /**
   * Automatically compress the early part of a session once it grows past
   * `autoCompactMinMessages` or `autoCompactMinChars` characters, before a
   * turn runs. Costs one extra summarising request per compaction.
   */
  autoCompact: boolean;
  /** Auto-compact once the stored conversation exceeds this many messages. */
  autoCompactMinMessages: number;
  /** Auto-compact once the stored message content exceeds this many chars. */
  autoCompactMinChars: number;
  ignoredPaths: string[];
  /**
   * Optional per-session cost ceiling in USD. Once the cumulative estimated
   * cost of a session reaches this amount (public list prices, like `stats`),
   * new turns are refused with a BUDGET_EXCEEDED error until the budget is
   * raised or a new session starts.
   */
  budgetUsd?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  readOnly: boolean;
}

export type SkillScope = 'workspace' | 'user' | 'system' | 'codex';

export interface SkillDescriptor {
  /** Stable reference used by the model and CLI. */
  ref: string;
  name: string;
  description: string;
  directory: string;
  skillFile: string;
  scope: SkillScope;
}

export interface SkillRecord extends SkillDescriptor {
  instructions: string;
}

export interface SkillCatalog {
  skills: SkillDescriptor[];
  warnings: string[];
  truncated: boolean;
  get(ref: string): SkillDescriptor | undefined;
  read(ref: string): Promise<SkillRecord>;
  readResource(ref: string, relativePath: string): Promise<{ path: string; content: string }>;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  success: boolean;
  output: string;
  data?: JsonValue;
  error?: {
    code: string;
    message: string;
    details?: JsonValue;
  };
  truncated?: boolean;
  durationMs?: number;
}

export interface ProviderToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export type ProviderEvent =
  | { type: 'text_delta'; delta: string }
  // Reasoning summary streamed by the provider (the model's visible thinking);
  // deltas concatenate into the full thinking text for one response turn.
  | { type: 'reasoning_delta'; delta: string }
  // The provider echoes the concrete reasoning effort the model actually used.
  // Emitted when the request left the effort to the model ('auto') so the UI
  // can tell the user whenever the agent picks or switches its own depth, and
  // inherit the chosen effort into subsequent requests of the session.
  | { type: 'reasoning_effort'; effort: ReasoningEffort }
  // Emitted by the agent when it automatically compacts a long session before
  // a turn, so the UI can surface a notice to the user.
  | { type: 'compacted'; message: string }
  | { type: 'tool_call'; call: ProviderToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | {
      type: 'response_completed';
      responseId: string;
      outputText?: string;
      finishReason?: string;
    }
  | {
      type: 'error';
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };

export interface ProviderMessageInput {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

export interface ProviderToolResultInput {
  type: 'function_call_output';
  callId: string;
  output: string;
}

export interface ProviderFunctionCallInput {
  type: 'function_call';
  callId: string;
  name: string;
  arguments: string;
  /** Provider-specific reasoning that must be replayed with thinking tool calls. */
  reasoningContent?: string;
}

export type ProviderInput =
  ProviderMessageInput | ProviderFunctionCallInput | ProviderToolResultInput;

export interface ProviderRequest {
  model: string;
  reasoning: ReasoningEffort;
  verbosity?: TextVerbosity;
  reasoningSummary?: ReasoningSummary;
  /** Hard per-request completion budget, including provider reasoning tokens. */
  maxOutputTokens?: number;
  instructions?: string;
  input: string | ProviderInput[];
  previousResponseId?: string;
  tools?: ToolDefinition[];
  store?: boolean;
  signal?: AbortSignal;
}

export interface AgentProvider {
  readonly name: string;
  /** Whether the provider accepts OpenAI Responses API response IDs for continuation. */
  readonly supportsResponseContinuation?: boolean;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
  checkConnection?(signal?: AbortSignal): Promise<void>;
}

export type SessionStatus = 'active' | 'completed' | 'cancelled' | 'failed';

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  responseId?: string;
  /** True for the synthetic summary message produced by a context compaction. */
  compressed?: boolean;
}

export interface SessionToolCall {
  callId: string;
  toolName: string;
  arguments: JsonValue;
  success: boolean;
  approved?: boolean;
  outputSummary?: string;
  truncated?: boolean;
  startedAt: string;
  completedAt?: string;
}

export interface SessionRecord {
  version: 1;
  id: string;
  workspace: string;
  provider: string;
  model: string;
  baseURL?: string;
  /** Reasoning effort the conversation was running at; restored on resume. */
  reasoning?: ReasoningEffort;
  status: SessionStatus;
  title?: string;
  /** Whether the title was generated automatically or set by the user. */
  titleSource?: 'automatic' | 'custom';
  /** Set after the model has produced the first automatic title. */
  titleGenerated?: boolean;
  createdAt: string;
  updatedAt: string;
  previousResponseId?: string;
  /** ISO timestamp of the last context compaction (`/compact`). */
  compactedAt?: string;
  messages: SessionMessage[];
  toolCalls: SessionToolCall[];
  usage?: TokenUsage;
  error?: {
    code: string;
    message: string;
  };
}

export type MutationOperation = 'create' | 'modify' | 'delete';

export interface MutationTransaction {
  version: 1;
  id: string;
  sessionId?: string;
  workspace: string;
  path: string;
  operation: MutationOperation;
  beforeHash: string | null;
  afterHash: string | null;
  beforeContent: string | null;
  beforeMode?: number;
  afterContent?: string | null;
  diff: string;
  createdAt: string;
  undoneAt?: string;
}
