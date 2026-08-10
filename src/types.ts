export type ApprovalPolicy = 'ask' | 'auto' | 'read-only';

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
}

export type ProviderInput =
  ProviderMessageInput | ProviderFunctionCallInput | ProviderToolResultInput;

export interface ProviderRequest {
  model: string;
  reasoning: ReasoningEffort;
  verbosity?: TextVerbosity;
  reasoningSummary?: ReasoningSummary;
  instructions?: string;
  input: string | ProviderInput[];
  previousResponseId?: string;
  tools?: ToolDefinition[];
  store?: boolean;
  signal?: AbortSignal;
}

export interface AgentProvider {
  readonly name: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
  checkConnection?(signal?: AbortSignal): Promise<void>;
}

export type SessionStatus = 'active' | 'completed' | 'cancelled' | 'failed';

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  responseId?: string;
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
  createdAt: string;
  updatedAt: string;
  previousResponseId?: string;
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
