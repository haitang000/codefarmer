import type {
  MutationOperation,
  MutationTransaction,
  ToolDefinition,
  ToolResult,
} from '../types.js';

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
  | 'git_show';

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
}

export interface ApprovalRequest {
  kind: 'file-mutation' | 'command';
  title: string;
  detail: string;
  readOnly?: boolean;
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
