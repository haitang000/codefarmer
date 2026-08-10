import type { ApprovalRequest } from '../core/approval.js';
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type GlobalOptions,
} from '../cli/runtime.js';
import type { ToolCall, ToolLifecycleHooks } from '../tools/types.js';
import type { ToolResult } from '../types.js';
import type { TuiToolEvent } from './types.js';
import type { ProviderToolCall } from '../types.js';

type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;
type ToolEventHandler = (event: TuiToolEvent) => void;

/**
 * Keeps terminal concerns out of the runtime factory. The runtime can be
 * created before React mounts; handlers are attached by TuiApp immediately
 * afterwards and are only called while a turn is running.
 */
export class TuiInteractionBridge {
  private approvalHandler: ApprovalHandler | undefined;
  private toolEventHandler: ToolEventHandler | undefined;

  public readonly approvalPrompt: ApprovalHandler = async (request) => {
    const handler = this.approvalHandler;
    return handler === undefined ? false : handler(request);
  };

  public readonly toolHooks: ToolLifecycleHooks = {
    onToolStart: (call) => this.emit({ type: 'tool_start', call: toProviderCall(call) }),
    onToolResult: (call, result) =>
      this.emit({ type: 'tool_result', call: toProviderCall(call), result }),
    onApprovalRequest: (request, call) =>
      this.emit({
        type: 'approval_request',
        request: toApprovalRequest(request),
        ...(call === undefined ? {} : { call: toProviderCall(call) }),
      }),
    onApprovalResolution: (request, approved, call) =>
      this.emit({
        type: 'approval_resolution',
        request: toApprovalRequest(request),
        approved,
        ...(call === undefined ? {} : { call: toProviderCall(call) }),
      }),
  };

  public setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  public setToolEventHandler(handler: ToolEventHandler | undefined): void {
    this.toolEventHandler = handler;
  }

  private emit(event: TuiToolEvent): void {
    this.toolEventHandler?.(event);
  }
}

function toProviderCall(call: ToolCall): ProviderToolCall {
  return {
    callId: call.callId,
    name: call.name,
    arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
  };
}

function toApprovalRequest(request: {
  kind: 'file-mutation' | 'command';
  title: string;
  detail: string;
  readOnly?: boolean;
  requireConfirmation?: boolean;
}): ApprovalRequest {
  return {
    kind: request.kind === 'file-mutation' ? 'patch' : 'command',
    title: request.title,
    detail: request.detail,
    ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
    ...(request.requireConfirmation === undefined
      ? {}
      : { requireConfirmation: request.requireConfirmation }),
  };
}

export type TuiRuntimeFactory = (sessionId?: string) => Promise<AgentRuntime>;

export function createTuiRuntimeFactory(
  options: GlobalOptions,
  bridge: TuiInteractionBridge,
): TuiRuntimeFactory {
  return async (sessionId) => {
    // Ink owns the terminal while the TUI is mounted; keep Pino diagnostics in files.
    const runtimeOptions: GlobalOptions = { ...options, verbose: false };
    const agentOptions: AgentRuntimeOptions = {
      history: true,
      approvalPrompt: bridge.approvalPrompt,
      interactive: true,
      toolHooks: bridge.toolHooks,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    return createAgentRuntime(runtimeOptions, agentOptions);
  };
}

export function formatToolResult(result: ToolResult): string {
  if (result.success) return result.output.length > 0 ? result.output : 'completed';
  return result.error?.message ?? 'tool failed';
}

/**
 * Turn the agent's summary reply into a usable `git commit -m` message.
 *
 * Models occasionally wrap their answer in a fenced code block or pad it
 * with extra blank lines; strip those and collapse runs of blank lines so a
 * subject/body separator stays a single blank line. Returns '' when the
 * reply contains nothing usable, in which case callers fall back to the
 * message derived from the changed paths.
 */
export function extractCommitMessage(text: string): string {
  let content = text.trim();
  // Prefer the first fenced code block when the model wraps its answer.
  const fenced = /```[^\n]*\n([\s\S]*?)```/u.exec(content)?.[1];
  if (fenced !== undefined) content = fenced.trim();
  return content.replace(/\n{3,}/gu, '\n\n').trim();
}
