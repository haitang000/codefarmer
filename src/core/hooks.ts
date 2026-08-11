import type { AgentRunResult } from './runtime-types.js';
import type { ProviderEvent, ProviderToolCall, ToolResult } from '../types.js';

export interface AgentHookContext {
  turnId: string;
  prompt: string;
  workspace: string;
  sessionId?: string;
}

export interface AgentToolHookContext extends AgentHookContext {
  call: ProviderToolCall;
}

/**
 * Process-local extension points for integrations and UI adapters. Hooks are
 * deliberately callbacks rather than workspace scripts so they cannot bypass
 * the normal tool and approval boundary.
 */
export interface AgentHooks {
  beforeTurn?: (context: AgentHookContext) => void | Promise<void>;
  afterTurn?: (context: AgentHookContext, result: AgentRunResult) => void | Promise<void>;
  beforeTool?: (context: AgentToolHookContext) => void | Promise<void>;
  afterTool?: (context: AgentToolHookContext, result: ToolResult) => void | Promise<void>;
  onProviderEvent?: (context: AgentHookContext, event: ProviderEvent) => void | Promise<void>;
}

export async function notifyAgentHook<T extends unknown[]>(
  hook: ((...args: T) => void | Promise<void>) | undefined,
  ...args: T
): Promise<void> {
  if (hook === undefined) return;
  await hook(...args);
}
