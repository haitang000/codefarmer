import type {
  ApprovalPolicy,
  CodeFarmerConfig,
  ProviderEvent,
  TokenUsage,
  ToolResult,
} from '../types.js';

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentRunOptions {
  prompt: string;
  workspace: string;
  sessionId?: string;
  previousResponseId?: string;
  config: CodeFarmerConfig;
  approval: ApprovalPolicy;
  signal?: AbortSignal;
  onEvent?: (event: ProviderEvent) => void;
}

export interface AgentRunResult {
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  message: string;
  responseId?: string;
  toolCalls: {
    id: string;
    name: string;
    arguments: unknown;
    result: ToolResult;
  }[];
  usage: TokenUsage;
  error?: { code: string; message: string };
}
