export type ApprovalPolicy = 'ask' | 'auto' | 'read-only';

export const PROVIDER_IDS = ['openai', 'gemini', 'grok', 'deepseek', 'kimi'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// 'auto' 表示不下发 effort，由模型自行决定思考深度。
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TextVerbosity = 'low' | 'medium' | 'high';
export type ReasoningSummary = 'none' | 'auto' | 'concise' | 'detailed';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface CodeFarmerConfig {
  provider: ProviderId;
  model: string;
  baseURL: string;
  reasoning: ReasoningEffort;
  verbosity: TextVerbosity;
  reasoningSummary: ReasoningSummary;
  approval: ApprovalPolicy;
  stream: boolean;
  store: true;
  logLevel: LogLevel;
  maxAgentTurns: number;
  /** Hard per-request completion budget, including provider reasoning tokens. */
  maxOutputTokens: number;
  maxFileSizeBytes: number;
  maxToolOutputBytes: number;
  commandTimeoutMs: number;
  ignoredPaths: string[];
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
  // can tell the user whenever the agent picks or switches its own depth.
  | { type: 'reasoning_effort'; effort: ReasoningEffort }
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
