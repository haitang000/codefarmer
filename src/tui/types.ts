import type { ApprovalRequest } from '../core/approval.js';
import type { ProviderToolCall, TokenUsage, ToolResult } from '../types.js';

export type TuiCommand =
  | { kind: 'prompt'; value: string }
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'status' }
  | { kind: 'context' }
  | { kind: 'effort' }
  | { kind: 'plan'; value: string }
  | { kind: 'config' }
  | { kind: 'doctor' }
  | { kind: 'diff' }
  | { kind: 'undo' }
  | { kind: 'sessions' }
  | { kind: 'resume'; id: string }
  | { kind: 'delete-session'; id: string }
  | { kind: 'quit' }
  | { kind: 'cancel' }
  | { kind: 'unknown'; name: string; args: string[] };

export type ToolViewStatus = 'requested' | 'running' | 'succeeded' | 'failed';

export interface ToolView {
  callId: string;
  name: string;
  status: ToolViewStatus;
  arguments?: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

export type TranscriptEntryKind = 'user' | 'assistant' | 'tool' | 'system' | 'error';

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  content: string;
  tool?: ToolView;
  /** 助手消息的推理摘要（思考过程），Ctrl+O 切换显示。 */
  reasoning?: string;
}

export interface ApprovalView {
  request: ApprovalRequest;
  call?: ProviderToolCall;
}

export interface TuiToolEvent {
  type: 'tool_start' | 'tool_result' | 'approval_request' | 'approval_resolution';
  call?: ProviderToolCall;
  request?: ApprovalRequest;
  approved?: boolean;
  result?: ToolResult;
}

export interface TuiUsage {
  usage: TokenUsage;
}

export const TUI_HELP = [
  '/help       show this help',
  'Ctrl+O      toggle the reasoning (thinking) display',
  '/new        start a new session',
  '/status     show workspace and runtime status',
  '/context    show the current conversation context and token usage',
  '/effort     open the reasoning effort picker (←/→ + Enter)',
  '/plan [on|off]  toggle plan mode (Shift+Tab): read-only research, no file changes',
  '/config     show the effective configuration',
  '/doctor     check the local runtime prerequisites',
  '/sessions   list saved sessions',
  '/resume ID  resume a saved session',
  '/delete ID  delete a saved session',
  '/diff       show the current Git diff',
  '/undo       undo the latest file mutation',
  '/cancel     cancel the active turn',
  '/quit       exit CodeFarmer',
].join('\n');

export function parseTuiCommand(input: string): TuiCommand {
  const value = input.trim();
  if (value.length === 0) return { kind: 'prompt', value: '' };
  if (!value.startsWith('/')) return { kind: 'prompt', value };

  const parts = value.slice(1).trim().split(/\s+/u).filter(Boolean);
  const name = (parts.shift() ?? '').toLowerCase();
  switch (name) {
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'new':
      return { kind: 'new' };
    case 'status':
      return { kind: 'status' };
    case 'context':
    case 'ctx':
      return { kind: 'context' };
    case 'effort':
    case 'reasoning':
      return { kind: 'effort' };
    case 'plan':
      return { kind: 'plan', value: (parts[0] ?? '').toLowerCase() };
    case 'config':
      return { kind: 'config' };
    case 'doctor':
      return { kind: 'doctor' };
    case 'diff':
      return { kind: 'diff' };
    case 'undo':
      return { kind: 'undo' };
    case 'sessions':
    case 'session':
      return { kind: 'sessions' };
    case 'resume':
      return { kind: 'resume', id: parts[0] ?? '' };
    case 'delete':
      return { kind: 'delete-session', id: parts[0] ?? '' };
    case 'cancel':
      return { kind: 'cancel' };
    case 'quit':
    case 'exit':
    case 'q':
      return { kind: 'quit' };
    default:
      return { kind: 'unknown', name, args: parts };
  }
}
