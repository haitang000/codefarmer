import type { ApprovalRequest } from '../core/approval.js';
import type { Language, ProviderToolCall, TokenUsage, ToolResult } from '../types.js';
import { normaliseLanguage } from '../types.js';

export type TuiCommand =
  | { kind: 'prompt'; value: string }
  | { kind: 'help' }
  | { kind: 'skills' }
  | { kind: 'skill'; ref: string }
  | { kind: 'init' }
  | { kind: 'new' }
  | { kind: 'status' }
  | { kind: 'stats' }
  | { kind: 'context' }
  | { kind: 'compact' }
  | { kind: 'effort' }
  | { kind: 'model'; value: string }
  | { kind: 'plan'; value: string }
  | { kind: 'auto'; value: string }
  | { kind: 'language'; value: string }
  | { kind: 'config' }
  | { kind: 'doctor' }
  | { kind: 'diff' }
  | { kind: 'commit'; message: string }
  | { kind: 'push'; args: string[] }
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
  /** Optional renderer hint for structured local command output. */
  display?: 'stats' | 'diff';
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

const TUI_HELP_EN = [
  'SESSION',
  '  /help       show this help',
  '  /new        start a new session',
  '  /sessions   open the saved-session picker',
  '  /resume ID  resume a saved session',
  '  /delete ID  delete a saved session',
  '  /compact    compress early messages into a summary',
  '  /cancel     cancel the active turn',
  '  /quit       exit CodeFarmer',
  'WORKSPACE',
  '  /status     show workspace and runtime status',
  '  /diff       show the current Git diff',
  '  /commit     stage and commit workspace changes',
  '  /push       push the current branch to its upstream',
  '  /undo       undo the latest file mutation',
  '  /init       summarize this workspace into AGENT.md',
  'PERMISSIONS',
  '  /plan [on|off]  read-only research mode',
  '  /auto [on|off]  plan and execute without ordinary approvals',
  '  /language [en|zh-CN]  set the interface and agent response language',
  '  Shift+Tab       cycle CODE, PLAN, and AUTO modes',
  '  /config     show the effective configuration',
  'DEBUG',
  '  /context    show context and token usage',
  '  /stats      show usage charts and estimated cost',
  '  /effort     open the reasoning effort picker (←/→ + Enter)',
  '  /model NAME switch the active model',
  '  /skills     list discovered skills',
  '  /skill REF  select a skill for this session; /skill off clears it',
  '  /doctor     check local runtime prerequisites',
  '  Ctrl+O      toggle the reasoning display',
].join('\n');

const TUI_HELP_ZH = [
  '会话',
  '  /help       显示帮助',
  '  /new        开始新会话',
  '  /sessions   打开已保存会话选择器',
  '  /resume ID  恢复已保存会话',
  '  /delete ID  删除已保存会话',
  '  /compact    压缩早期消息为摘要',
  '  /cancel     取消当前任务',
  '  /quit       退出 CodeFarmer',
  '工作区',
  '  /status     显示工作区和运行状态',
  '  /diff       显示当前 Git 差异',
  '  /commit     暂存并提交工作区变更',
  '  /push       推送当前分支到上游',
  '  /undo       撤销最近一次文件变更',
  '  /init       将工作区摘要写入 AGENT.md',
  '权限',
  '  /plan [on|off]  只读研究模式',
  '  /auto [on|off]  计划并执行，自动批准普通操作',
  '  /language [en|zh-CN]  设置界面和 Agent 回复语言',
  '  Shift+Tab       循环切换 CODE、PLAN、AUTO 模式',
  '  /config     显示生效配置',
  '调试',
  '  /context    显示上下文和 Token 用量',
  '  /stats      显示用量图表和估算费用',
  '  /effort     打开推理强度选择器（←/→ + Enter）',
  '  /model NAME 切换当前模型',
  '  /skills     列出已发现技能',
  '  /skill REF  为本会话选择技能；/skill off 清除',
  '  /doctor     检查本地运行环境',
  '  Ctrl+O      切换推理摘要显示',
].join('\n');

export function getTuiHelp(language: Language = 'en'): string {
  return language === 'zh-CN' ? TUI_HELP_ZH : TUI_HELP_EN;
}

export const TUI_HELP = TUI_HELP_EN;

/** Commands offered by the interactive prompt, in display/completion order. */
export const TUI_COMMANDS = [
  'help',
  'skills',
  'skill',
  'init',
  'new',
  'status',
  'stats',
  'context',
  'compact',
  'effort',
  'model',
  'plan',
  'auto',
  'language',
  'config',
  'doctor',
  'sessions',
  'resume',
  'delete',
  'diff',
  'commit',
  'push',
  'undo',
  'cancel',
  'quit',
] as const;

/**
 * Returns the suffix of the unique slash command matching the current draft.
 * Suggestions are intentionally limited to a bare command token so ordinary
 * prompts and command arguments are never rewritten behind the user's back.
 */
export function tuiCommandAdvice(input: string): string {
  if (!input.startsWith('/') || /\s/u.test(input)) return '';
  const typed = input.slice(1).toLowerCase();
  if (typed.length === 0) return TUI_COMMANDS[0];
  const matches = TUI_COMMANDS.filter((command) => command.startsWith(typed));
  const match = matches.length === 1 ? matches[0] : undefined;
  return match === undefined ? '' : match.slice(typed.length);
}

/** Accept the current unique command suggestion, returning the unchanged draft
 * when there is no suggestion to accept. */
export function completeTuiCommand(input: string): string {
  const advice = tuiCommandAdvice(input);
  return advice.length === 0 ? input : `${input}${advice}`;
}

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
    case 'skills':
      return { kind: 'skills' };
    case 'skill':
      return { kind: 'skill', ref: parts[0] ?? '' };
    case 'init':
      return { kind: 'init' };
    case 'new':
      return { kind: 'new' };
    case 'status':
      return { kind: 'status' };
    case 'stats':
      return { kind: 'stats' };
    case 'context':
    case 'ctx':
      return { kind: 'context' };
    case 'compact':
      return { kind: 'compact' };
    case 'effort':
    case 'reasoning':
      return { kind: 'effort' };
    case 'model':
      return { kind: 'model', value: parts.join(' ') };
    case 'plan':
      return { kind: 'plan', value: (parts[0] ?? '').toLowerCase() };
    case 'auto':
      return { kind: 'auto', value: (parts[0] ?? '').toLowerCase() };
    case 'language':
    case 'lang': {
      const requested = parts.join(' ');
      const canonical = requested.length === 0 ? '' : (normaliseLanguage(requested) ?? requested);
      return { kind: 'language', value: canonical };
    }
    case 'config':
      return { kind: 'config' };
    case 'doctor':
      return { kind: 'doctor' };
    case 'diff':
      return { kind: 'diff' };
    case 'commit':
      return { kind: 'commit', message: parts.join(' ') };
    case 'push':
      return { kind: 'push', args: parts };
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

export type AgentMode = 'code' | 'plan' | 'auto';

export function nextAgentMode(mode: AgentMode): AgentMode {
  if (mode === 'code') return 'plan';
  if (mode === 'plan') return 'auto';
  return 'code';
}
