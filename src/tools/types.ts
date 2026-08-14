import type {
  MutationOperation,
  MutationTransaction,
  ToolDefinition,
  ToolResult,
} from '../types.js';
import type { SkillCatalog } from '../types.js';
import type { TodoStore } from '../core/todos.js';

export type ToolName =
  | 'list_files'
  | 'read_file'
  | 'search_text'
  | 'apply_patch'
  | 'write_file'
  | 'run_command'
  | 'git_status'
  | 'git_diff'
  | 'git_log'
  | 'git_show'
  | 'web_fetch'
  | 'web_search'
  | 'todo_write'
  | 'read_skill'
  | 'read_skill_resource';

export interface ToolContextOptions {
  workspace: string;
  maxFileBytes?: number;
  maxOutputBytes?: number;
  commandTimeoutMs?: number;
  ignoredPaths?: string[];
  signal?: AbortSignal;
  sessionId?: string;
  onMutation?: (mutation: MutationTransaction) => void | Promise<void>;
  approve?: (request: ApprovalRequest) => boolean | Promise<boolean>;
  hooks?: ToolLifecycleHooks;
  skillCatalog?: SkillCatalog;
  /**
   * Test and local-tool escape hatch: when true, web_fetch may target
   * private, loopback, and link-local addresses. The CLI never sets this.
   */
  allowPrivateAddresses?: boolean;
  /** Test-only override for the web_search endpoint. The CLI never sets this. */
  webSearchEndpoint?: string;
  todos?: TodoStore;
}

export interface ResolvedToolContext {
  workspace: string;
  maxFileBytes: number;
  maxOutputBytes: number;
  commandTimeoutMs: number;
  signal?: AbortSignal;
  sessionId?: string;
  onMutation?: (mutation: MutationTransaction) => void | Promise<void>;
  approve?: (request: ApprovalRequest) => boolean | Promise<boolean>;
  skillCatalog?: SkillCatalog;
  allowPrivateAddresses?: boolean;
  webSearchEndpoint?: string;
  todos?: TodoStore;
}

export interface ApprovalRequest {
  kind: 'file-mutation' | 'command';
  title: string;
  detail: string;
  readOnly?: boolean;
  /** Requires an explicit interactive decision even under the auto policy. */
  requireConfirmation?: boolean;
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface ToolCallResult {
  callId: string;
  name: string;
  result: ToolResult;
}

/** Notifications emitted while a registered tool is being evaluated. */
export interface ToolLifecycleHooks {
  /** A veto point for integrations that need to stop a tool before execution. */
  beforeTool?: (call: ToolCall) => void | Promise<void>;
  /** Post-tool observers must not change the tool result. */
  afterTool?: (call: ToolCall, result: ToolResult) => void | Promise<void>;
  onToolStart?: (call: ToolCall) => void | Promise<void>;
  onToolResult?: (call: ToolCall, result: ToolResult) => void | Promise<void>;
  onApprovalRequest?: (request: ApprovalRequest, call?: ToolCall) => void | Promise<void>;
  onApprovalResolution?: (
    request: ApprovalRequest,
    approved: boolean,
    call?: ToolCall,
  ) => void | Promise<void>;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
  hooks?: ToolLifecycleHooks;
  /** When true, mutating tools are rejected with PLAN_MODE_FORBIDDEN. */
  plan?: boolean;
  /** Auto-approve ordinary mutations for this turn; protected operations still prompt. */
  autoApprove?: boolean;
  /** The originating call, populated by ToolRegistry for lifecycle observers. */
  call?: ToolCall;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: (
    arguments_: Record<string, unknown>,
    callId: string,
    options?: ToolExecutionOptions,
  ) => Promise<ToolResult>;
}

export type { MutationOperation, MutationTransaction, ToolDefinition, ToolResult };
