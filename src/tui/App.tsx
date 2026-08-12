import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

import { execa } from 'execa';
import wrapAnsi from 'wrap-ansi';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';

import type { ApprovalDecision, ApprovalRequest } from '../core/approval.js';
import type { AgentRunResult } from '../core/runtime-types.js';
import type { AgentRuntime } from '../cli/runtime.js';
import { writeConfigFile, type ConfigFile } from '../infra/config.js';
import { getAppPaths } from '../infra/paths.js';
import { readJsonFileIfExists } from '../infra/persistence.js';
import {
  commitWorkspaceChanges,
  detectGitAvailability,
  inspectWorkingTree,
} from '../tools/git-tools.js';
import { sanitiseEnvironment } from '../tools/run-command.js';
import type { Language, ProviderEvent, ReasoningEffort, TokenUsage } from '../types.js';
import { normaliseLanguage } from '../types.js';
import {
  COMPACT_HINT_MIN_CHARS,
  COMPACT_HINT_MIN_MESSAGES,
  COMPACT_KEEP_RECENT_MESSAGES,
  sessionContextChars,
} from '../core/session-compact.js';
import { formatSkillCatalog } from '../core/skills.js';
import { computeWorkspaceStats, type WorkspaceStats } from '../core/stats.js';
import { DiffView, MarkdownLine, MarkdownView, diffLineColor } from './markdown.js';
import {
  extractCommitMessage,
  formatToolResult,
  type TuiInteractionBridge,
  type TuiRuntimeFactory,
} from './runtime.js';
import { formatTerminalTitle, normaliseSessionTitle } from './title.js';
import {
  parseTuiCommand,
  nextAgentMode,
  getTuiHelp,
  completeTuiCommand,
  tuiCommandAdvice,
  type ApprovalView,
  type AgentMode,
  type ToolView,
  type TranscriptEntry,
  type TuiCommand,
  type TuiToolEvent,
} from './types.js';

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
// Reasoning effort levels offered by the /effort picker; the array order is
// also the left/right navigation order. 'auto' 不是具体强度，而是让模型自行
// 决定思考深度，排在最左侧作为默认入口。
const EFFORT_CHOICES = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
// 每个思考深度有专属颜色，沿冷到暖的渐变递进（档位越高颜色越“热”），
// 滑轨上一眼可辨当前所处位置；auto 用蓝色与具体档位区分。
const EFFORT_COLORS: Record<ReasoningEffort, string> = {
  auto: 'blue',
  none: 'gray',
  low: 'green',
  medium: 'cyan',
  high: 'yellow',
  xhigh: 'magenta',
  max: 'red',
};
const BRAND_COLOR = '#D97757';
const PANEL_BORDER_COLOR = '#5F5551';
const SECONDARY_TEXT_COLOR = '#B8B2AE';
const READY_COLOR = '#82B86B';
// Slash commands that stay available while a turn is running; plain prompts
// typed meanwhile remain in the input buffer until the active turn finishes.
const READ_ONLY_COMMANDS: ReadonlySet<TuiCommand['kind']> = new Set([
  'help',
  'skills',
  'context',
  'effort',
  'plan',
  'auto',
  'language',
  'status',
  'stats',
  'config',
  'doctor',
  'sessions',
  'diff',
]);

function canRunWhileBusy(command: TuiCommand): boolean {
  return (
    command.kind === 'cancel' || command.kind === 'quit' || READ_ONLY_COMMANDS.has(command.kind)
  );
}

const INIT_AGENT_PROMPT = `Initialize this workspace by creating or updating a root-level AGENT.md.

First inspect the repository with the available read-only tools. Identify the actual project purpose,
languages and frameworks, package and build/test/lint commands, important source directories, and any
local conventions that are evidenced by the files. If AGENT.md already exists, read it and preserve
useful project-specific guidance while refreshing stale sections.

Then write AGENT.md using write_file (or apply_patch) with a concise Markdown summary for future coding
agents. Include only facts you verified in the workspace. Prefer sections such as Project Overview,
Repository Layout, Development Commands, Coding Conventions, Testing, and Important Constraints.
Do not modify any other file. Finish by reporting the path and a short summary of what was documented.`;

const COMMIT_SUMMARY_PROMPT = `Write a concise Git commit message that summarizes the uncommitted changes in this workspace.

Inspect the working tree with the read-only Git tools (git_status, git_diff, and git_log when useful)
and base the message only on facts you verify from the diff. The changes will be staged and committed
exactly as you describe.

Requirements:
- Output ONLY the commit message, with no preamble, explanation, markdown code fences, or bullet markers.
- Prefer a conventional-commit subject line (for example "feat: ...", "fix: ...", "refactor: ...") of
  at most 72 characters.
- When the change is non-trivial, follow the subject with a blank line and a few short bullet points
  describing what changed and why.
- Do not modify, stage, or commit anything; this turn is read-only research.`;

export interface TuiAppProps {
  initialRuntime: AgentRuntime;
  runtimeFactory: TuiRuntimeFactory;
  bridge: TuiInteractionBridge;
  initialPlanMode?: boolean;
  /** 初始是否展示思考过程（Ctrl+O 切换）。 */
  initialShowThinking?: boolean;
  /** Synchronises the terminal window title with the active session. */
  onTerminalTitleChange?: (title: string) => void;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const TOOL_OUTPUT_PREVIEW_LIMIT = 160;

const TUI_PUSH_GIT_ENV = {
  GIT_EXTERNAL_DIFF: '',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};

interface PushPreview {
  branch: string;
  remote: string;
  upstream: string;
  ahead: string[];
}

function pushGitOptions(workspace: string): {
  cwd: string;
  reject: false;
  env: NodeJS.ProcessEnv;
  extendEnv: false;
} {
  return {
    cwd: workspace,
    reject: false,
    env: sanitiseEnvironment({ ...process.env, ...TUI_PUSH_GIT_ENV }),
    extendEnv: false,
  };
}

async function previewCurrentBranchPush(workspace: string): Promise<PushPreview> {
  const branchResult = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    ...pushGitOptions(workspace),
  });
  if (branchResult.exitCode !== 0) {
    throw new Error(branchResult.stderr.trim() || 'Unable to read the current Git branch.');
  }
  const branch = branchResult.stdout.trim();
  if (branch === 'HEAD') {
    throw new Error('Cannot push from a detached HEAD. Switch to a branch first.');
  }

  const upstreamResult = await execa(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`],
    pushGitOptions(workspace),
  );
  if (upstreamResult.exitCode !== 0) {
    throw new Error(
      `Branch ${branch} has no upstream. Set it with codefarmer push --set-upstream --remote origin.`,
    );
  }
  const upstream = upstreamResult.stdout.trim();
  const slash = upstream.indexOf('/');
  const remote = slash > 0 ? upstream.slice(0, slash) : '';
  if (remote.length === 0 || remote.startsWith('-') || branch.startsWith('-')) {
    throw new Error(`Invalid upstream configured for branch ${branch}.`);
  }

  const aheadResult = await execa('git', ['log', '--oneline', `${branch}@{u}..HEAD`], {
    ...pushGitOptions(workspace),
  });
  if (aheadResult.exitCode !== 0) {
    throw new Error(aheadResult.stderr.trim() || 'Unable to inspect commits pending push.');
  }
  return {
    branch,
    remote,
    upstream,
    ahead: aheadResult.stdout.split('\n').filter((line) => line.length > 0),
  };
}

// Tool outputs (file contents, command streams) can span thousands of lines;
// the transcript only needs a compact single-line preview.
function toolOutputPreview(output: string): string {
  const flat = output.replace(/\s+/gu, ' ').trim();
  if (flat.length <= TOOL_OUTPUT_PREVIEW_LIMIT) return flat;
  return `${flat.slice(0, TOOL_OUTPUT_PREVIEW_LIMIT)}…`;
}

const TOOL_ARGUMENT_PREVIEW_LIMIT = 60;
// Tool call arguments arrive as JSON; these keys carry the most meaningful
// detail (usually the path or the command) for a compact one-line preview.
const ARGUMENT_PREVIEW_KEYS = [
  'path',
  'file',
  'cwd',
  'executable',
  'command',
  'query',
  'name',
  'dir',
  'target',
  'sessionId',
] as const;

export function toolArgumentPreview(args: string | undefined): string | undefined {
  if (args === undefined || args.length === 0) return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const key of ARGUMENT_PREVIEW_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 0) {
        return value.length > TOOL_ARGUMENT_PREVIEW_LIMIT
          ? `${value.slice(0, TOOL_ARGUMENT_PREVIEW_LIMIT - 1)}…`
          : value;
      }
    }
  } catch {
    // Not JSON; fall through to the raw clipped text below.
  }
  const flat = args.replace(/\s+/gu, ' ').trim();
  if (flat.length <= TOOL_ARGUMENT_PREVIEW_LIMIT) return flat;
  return `${flat.slice(0, TOOL_ARGUMENT_PREVIEW_LIMIT - 1)}…`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function runtimeEntries(runtime: AgentRuntime): TranscriptEntry[] {
  const timeline: { entry: TranscriptEntry; timestamp: string; priority: number }[] = [];
  for (const message of runtime.session?.messages ?? []) {
    timeline.push({
      entry: {
        id: message.id,
        kind: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
        content: message.content,
      },
      timestamp: message.createdAt,
      // If two events share the same millisecond, retain the natural turn
      // order: prompt, tool result, then the model's response.
      priority: message.role === 'user' ? 0 : 2,
    });
  }
  for (const call of runtime.session?.toolCalls ?? []) {
    const tool: ToolView = {
      callId: call.callId,
      name: call.toolName,
      status: call.success ? 'succeeded' : 'failed',
      ...(call.outputSummary === undefined ? {} : { output: call.outputSummary }),
    };
    timeline.push({
      entry: { id: `tool-${call.callId}`, kind: 'tool', content: call.toolName, tool },
      timestamp: call.completedAt ?? call.startedAt,
      priority: 1,
    });
  }
  return timeline
    .sort((left, right) => {
      const timeOrder = left.timestamp.localeCompare(right.timestamp);
      return timeOrder === 0 ? left.priority - right.priority : timeOrder;
    })
    .map(({ entry }) => entry);
}

/**
 * Insert a requested tool after the response that led to it. An empty
 * assistant placeholder is discarded, because it only represented a pending
 * response that turned into a tool call instead of spoken output.
 */
export function appendToolEntryAtResponseBoundary(
  entries: TranscriptEntry[],
  assistantId: string | undefined,
  assistantHasOutput: boolean,
  toolEntry: TranscriptEntry,
): TranscriptEntry[] {
  const withoutEmptyPlaceholder =
    assistantId !== undefined && !assistantHasOutput
      ? entries.filter((entry) => entry.id !== assistantId)
      : entries;
  const existingIndex = withoutEmptyPlaceholder.findIndex(
    (entry) => entry.tool?.callId === toolEntry.tool?.callId,
  );
  if (existingIndex < 0) return [...withoutEmptyPlaceholder, toolEntry];
  const next = [...withoutEmptyPlaceholder];
  next[existingIndex] = toolEntry;
  return next;
}

function runtimeEntriesWithWelcome(runtime: AgentRuntime): TranscriptEntry[] {
  return runtimeEntries(runtime);
}

export function WelcomePanel({
  workspace,
  sessionTitle,
  model,
  columns,
  language = 'en',
}: {
  workspace: string;
  sessionTitle: string;
  model: string;
  columns: number;
  language?: 'en' | 'zh-CN';
}): React.ReactElement {
  const compact = columns < 76;
  const zh = language === 'zh-CN';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={PANEL_BORDER_COLOR}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text color={BRAND_COLOR} bold>
            {'CodeFarmer'}
          </Text>
          <Text color={PANEL_BORDER_COLOR}>{'  /  '}</Text>
          <Text color={SECONDARY_TEXT_COLOR}>{'v0.1.1'}</Text>
        </Box>
        <Text color={READY_COLOR} bold>
          {zh ? '● 就绪' : '● READY'}
        </Text>
      </Box>

      <Box flexDirection={compact ? 'column' : 'row'} marginTop={1}>
        <Box
          flexDirection="column"
          width={compact ? Math.max(1, columns - 8) : '38%'}
          paddingRight={compact ? 0 : 3}
        >
          <Text color={BRAND_COLOR} bold>
            {zh ? '欢迎回来' : 'WELCOME BACK'}
          </Text>
          <Text color="white" bold wrap="truncate-end">
            {sessionTitle}
          </Text>
          <Box marginTop={1}>
            <Text color={PANEL_BORDER_COLOR}>{'▸  '}</Text>
            <Text color={SECONDARY_TEXT_COLOR} wrap="truncate-end">
              {workspace}
            </Text>
          </Box>
          <Box>
            <Text color={PANEL_BORDER_COLOR}>{'◇  '}</Text>
            <Text color={SECONDARY_TEXT_COLOR} wrap="truncate-end">
              {model}
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={compact ? 1 : 0} flexGrow={1}>
          <Text color={BRAND_COLOR} bold>
            {zh ? '快速开始' : 'QUICK START'}
          </Text>
          <Box>
            <Text color={PANEL_BORDER_COLOR}>{'01  '}</Text>
            <Text color="white" bold>
              {'/init  '}
            </Text>
            <Text color={SECONDARY_TEXT_COLOR} wrap="truncate-end">
              {zh ? '创建工作区说明' : 'Create workspace instructions'}
            </Text>
          </Box>
          <Box>
            <Text color={PANEL_BORDER_COLOR}>{'02  '}</Text>
            <Text color="white" bold>
              {'ENTER  '}
            </Text>
            <Text color={SECONDARY_TEXT_COLOR} wrap="truncate-end">
              {zh ? '描述要完成的修改' : 'Describe the change you want to make'}
            </Text>
          </Box>
          <Box>
            <Text color={PANEL_BORDER_COLOR}>{'03  '}</Text>
            <Text color="white" bold>
              {'/help  '}
            </Text>
            <Text color={SECONDARY_TEXT_COLOR} wrap="truncate-end">
              {zh ? '浏览会话、权限和工具' : 'Browse sessions, permissions, and tools'}
            </Text>
          </Box>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="cyan" bold>
          {zh ? '新增  ' : 'NEW  '}
        </Text>
        <Text color={SECONDARY_TEXT_COLOR} wrap="truncate-end">
          {zh
            ? '排队跟进 · 分级审批 · 更安静的工作台'
            : 'Queued follow-ups · Scoped approvals · Quieter workbench'}
        </Text>
      </Box>
    </Box>
  );
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewLine(text: string, maximumLength = 60): string {
  const first = text.trimStart().split(/\r?\n/u, 1)[0] ?? '';
  return first.length > maximumLength ? `${first.slice(0, maximumLength - 1)}…` : first;
}

/**
 * Assumed model context window (tokens) used only to render an estimated
 * usage ratio in `/context`; the real limit depends on the provider/model.
 */
export const ESTIMATED_CONTEXT_WINDOW_TOKENS = 128_000;

/** Group thousands for readability, independent of the terminal locale. */
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Rough char→token estimate for human display: ASCII text ≈ 4 chars per
 * token, CJK and other wide characters ≈ 1 token each. Only used to make
 * `/context` usage intuitive, never to trim or budget history.
 */
export function estimateContextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

/** Render a ratio as a fixed-width bar of filled/empty blocks. */
export function usageBar(ratio: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/** Render aggregate usage as a compact terminal dashboard for the TUI. */
export function formatWorkspaceStats(stats: WorkspaceStats): string {
  const statusLabels: Record<keyof WorkspaceStats['statusCounts'], string> = {
    active: 'active',
    completed: 'done',
    cancelled: 'cancelled',
    failed: 'failed',
  };
  const maxStatus = Math.max(1, ...Object.values(stats.statusCounts));
  const maxTokens = Math.max(1, ...stats.byModel.map((stat) => stat.usage.totalTokens));
  const modelLines =
    stats.byModel.length === 0
      ? ['  (no recorded token usage)']
      : stats.byModel.map((stat) => {
          const cost = stat.priceMatched ? `$${stat.estimatedCostUsd.toFixed(4)}` : 'unknown';
          const model = stat.model.length > 28 ? `${stat.model.slice(0, 27)}…` : stat.model;
          return `  ${model.padEnd(28, ' ')} ${usageBar(stat.usage.totalTokens / maxTokens, 20)} ${formatNumber(stat.usage.totalTokens).padStart(10, ' ')}  ${cost}`;
        });
  const statusLines = (
    Object.entries(stats.statusCounts) as [keyof WorkspaceStats['statusCounts'], number][]
  ).map(
    ([status, count]) =>
      `  ${statusLabels[status].padEnd(9, ' ')} ${usageBar(count / maxStatus, 12)} ${String(count)}`,
  );
  return [
    `Sessions    ${formatNumber(stats.totalSessions)} (usage ${formatNumber(stats.sessionsWithUsage)})`,
    `Messages    ${formatNumber(stats.totalMessages)}   Tools ${formatNumber(stats.totalToolCalls)}`,
    `Activity    7d ${formatNumber(stats.recent.last7Days)}   30d ${formatNumber(stats.recent.last30Days)}`,
    `Tokens      in ${formatNumber(stats.usage.inputTokens)} / out ${formatNumber(stats.usage.outputTokens)} / total ${formatNumber(stats.usage.totalTokens)}`,
    `Cost        $${stats.estimatedCostUsd.toFixed(4)} estimated (matched models only)`,
    '',
    'Status',
    ...statusLines,
    '',
    'Tokens by model (bar = relative usage)',
    '  Model                        Usage                  Tokens       Cost',
    ...modelLines,
    ...(stats.costUnknownModels.length === 0
      ? []
      : ['', `Unknown price models: ${stats.costUnknownModels.join(', ')}`]),
  ].join('\n');
}

type StatsColor = 'cyan' | 'green' | 'yellow' | 'magenta' | 'red' | 'gray';

function statsLineColor(line: string): StatsColor {
  if (line.startsWith('Status') || line.startsWith('Tokens by model')) return 'cyan';
  if (line.startsWith('  Model')) return 'green';
  if (/^\s{2}(active|done|cancelled|failed)\s/u.test(line)) return 'yellow';
  if (line.startsWith('  ') && line.includes('█')) return 'green';
  if (line.startsWith('Unknown price')) return 'red';
  if (line.startsWith('Cost')) return 'yellow';
  if (line.startsWith('Tokens')) return 'magenta';
  return 'gray';
}

function StatsView({
  content,
  marginBottom = 0,
}: {
  content: string;
  marginBottom?: number;
}): React.ReactElement {
  return (
    <Box paddingLeft={2} flexDirection="column" marginBottom={marginBottom}>
      {content.split('\n').map((line, index) => (
        <Text
          key={`${String(index)}-${line}`}
          color={statsLineColor(line)}
          bold={line === 'Status' || line.startsWith('Tokens by model')}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}

// Keep the active-turn indicator compact; tool-call labels still take over
// verbatim when present (for example, "Preparing read_file").
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

const THINKING_PHRASES: Record<Language, readonly string[]> = {
  en: [
    'Analysing context',
    'Planning next step',
    'Organising workspace',
    'Checking implementation',
    'Preparing tool call',
    'Verifying result',
    'Drafting reply',
  ],
  'zh-CN': [
    '分析上下文',
    '规划下一步',
    '整理工作区',
    '检查实现细节',
    '准备工具调用',
    '验证执行结果',
    '生成回复',
  ],
};

// Thinking state renders as a scan-light text effect instead of a skeleton
// bar or typewriter: the full phrase sits dimmed while a bright band sweeps
// left-to-right across it, lighting up each character as it passes, like a
// torch gliding over the text.
const SCAN_BAND = 3; // number of characters lit up at once

function ThinkingText({ language = 'en' }: { language?: Language }): React.ReactElement {
  const phrases = THINKING_PHRASES[language];
  const [phraseIndex, setPhraseIndex] = useState(() => Math.floor(Math.random() * phrases.length));
  const [pos, setPos] = useState(0);
  const phrase = phrases[phraseIndex] ?? phrases[0] ?? 'Thinking';

  useEffect(() => {
    const timer = setInterval(() => {
      setPos((previous) => {
        // One full sweep (the band crosses every char), then move to the next phrase.
        if (previous >= phrase.length + SCAN_BAND) {
          setPhraseIndex((i) => (i + 1) % phrases.length);
          return 0;
        }
        return previous + 1;
      });
    }, 55);
    return () => clearInterval(timer);
  }, [phrase, phrases]);

  const chars = Array.from(phrase);
  return (
    <Text bold>
      {chars.map((ch, i) => {
        const lit = i >= pos - SCAN_BAND && i < pos;
        return lit ? (
          <Text key={i} color="yellow">
            {ch}
          </Text>
        ) : (
          <Text key={i} color="yellow" dimColor>
            {ch}
          </Text>
        );
      })}
      <Text dimColor>…</Text>
    </Text>
  );
}

function Spinner({
  label,
  language = 'en',
}: {
  label: string;
  language?: Language;
}): React.ReactElement {
  if (label === 'Thinking') {
    return <ThinkingText language={language} />;
  }
  const phrases = THINKING_PHRASES[language];
  const [frame, setFrame] = useState(0);
  const [phraseIndex, setPhraseIndex] = useState(() => Math.floor(Math.random() * phrases.length));
  useEffect(() => {
    const frameTimer = setInterval(() => {
      setFrame((previous) => (previous + 1) % SPINNER_FRAMES.length);
    }, 90);
    const phraseTimer = setInterval(() => {
      setPhraseIndex((previous) => (previous + 1) % phrases.length);
    }, 1500);
    return () => {
      clearInterval(frameTimer);
      clearInterval(phraseTimer);
    };
  }, [phrases]);
  const text = label === 'Thinking' ? (phrases[phraseIndex] ?? phrases[0] ?? 'Thinking') : label;
  return (
    <Text color="yellow" bold>
      {SPINNER_FRAMES[frame] ?? '◐'} {text}
    </Text>
  );
}

// File mutation tools report their scope as a "(+A -R)" suffix in their
// output; surfacing it on the compact tool line keeps the change size visible
// without adding another row to the transcript.
export function mutationStats(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const match = /\(([+-]\d+(?: [+-]\d+)?)\)$/u.exec(output);
  return match === null ? undefined : match[1];
}

// Tool calls render as compact single lines so long tool chains do not flood
// the transcript; failures keep their full error output below the header.
// Prefix (status glyph) and body (name + duration) are styled separately so
// the glyph stays crisp even when the body is dimmed.
function toolLine(tool: ToolView): {
  prefix: string;
  name: string;
  detail: string | undefined;
  stats: string | undefined;
  color: 'green' | 'red' | 'yellow';
} {
  const duration = tool.durationMs === undefined ? '' : ` ${formatDuration(tool.durationMs)}`;
  const detail = toolArgumentPreview(tool.arguments);
  if (tool.status === 'failed') {
    return { prefix: '✗', name: `${tool.name}${duration}`, detail, stats: undefined, color: 'red' };
  }
  if (tool.status === 'succeeded') {
    return {
      prefix: '✓',
      name: `${tool.name}${duration}`,
      detail,
      stats: mutationStats(tool.output),
      color: 'green',
    };
  }
  return {
    prefix: '▸',
    name: `${tool.name}${duration}…`,
    detail,
    stats: undefined,
    color: 'yellow',
  };
}

function clipApprovalDetail(detail: string, width: number, maximumLines: number): string {
  const lineWidth = Math.max(8, width - 6);
  const lines: string[] = [];
  for (const sourceLine of detail.slice(0, 3000).split(/\r?\n/u)) {
    if (sourceLine.length === 0) {
      lines.push('');
    } else {
      for (let offset = 0; offset < sourceLine.length; offset += lineWidth) {
        lines.push(sourceLine.slice(offset, offset + lineWidth));
      }
    }
  }
  const truncated = detail.length > 3000 || lines.length > maximumLines;
  const visible = lines.slice(0, maximumLines);
  if (truncated) {
    const marker = '...[truncated]';
    if (visible.length === 0) return marker;
    const last = visible.length - 1;
    visible[last] =
      `${visible[last]?.slice(0, Math.max(0, lineWidth - marker.length)) ?? ''}${marker}`;
  }
  return visible.join('\n');
}

function formatApprovalDetail(request: ApprovalRequest): string {
  if (request.kind !== 'command') return request.detail;
  try {
    const parsed: unknown = JSON.parse(request.detail);
    if (Array.isArray(parsed) && parsed.every((part): part is string => typeof part === 'string')) {
      const command = parsed
        .map((part) => (/^[\w./:=+@%-]+$/u.test(part) ? part : JSON.stringify(part)))
        .join(' ');
      return command.length === 0 ? request.detail : `$ ${command}`;
    }
  } catch {
    // Keep the original detail visible when a tool sends non-JSON metadata.
  }
  return request.detail;
}

// 思考过程以暗色块渲染在助手正文之前；行数估算与裁剪渲染共用同一份
// 行数据，保证滚动裁剪位置与实际布局一致。
function thinkingLines(reasoning: string, width: number): string[] {
  return ['✦ Thinking', ...wrapToLines(reasoning, width)];
}

export function EntryView({
  entry,
  trailingGap = true,
  showThinking = false,
  width,
}: {
  entry: TranscriptEntry;
  trailingGap?: boolean;
  showThinking?: boolean;
  /** 转录区宽度；思考块按与行数估算相同的宽度预换行。 */
  width: number;
}): React.ReactElement {
  const marginBottom = trailingGap ? 1 : 0;
  if (entry.kind === 'user') {
    return (
      <Box key={entry.id} flexDirection="column" marginBottom={marginBottom}>
        <Text color="cyan" bold>
          {'◆ YOU'}
        </Text>
        <Box paddingLeft={2}>
          <Text wrap="wrap">{entry.content}</Text>
        </Box>
      </Box>
    );
  }

  if (entry.kind === 'assistant') {
    return (
      <Box key={entry.id} flexDirection="column" marginBottom={marginBottom}>
        <Text color="green" bold>
          {'◆ CODEFARMER'}
        </Text>
        {showThinking && entry.reasoning !== undefined && entry.reasoning.length > 0 ? (
          <Box paddingLeft={2} flexDirection="column">
            {thinkingLines(entry.reasoning, Math.max(1, width - 2)).map((line, index) => (
              <Text
                key={index}
                dimColor={index > 0}
                {...(index === 0 ? { color: 'magenta' as const } : {})}
                wrap="truncate-end"
              >
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
        {entry.content.length === 0 ? (
          <Text dimColor>{'  Waiting for response…'}</Text>
        ) : (
          // Markdown 块是多个并排的 Text 组件，row 布局会把它们拼接成同一文本流换行；
          // column 布局让每个块独立成行，换行位置与源文本一致。
          <Box paddingLeft={2} flexDirection="column">
            <MarkdownView content={entry.content} />
          </Box>
        )}
      </Box>
    );
  }

  if (entry.kind === 'tool' && entry.tool !== undefined) {
    const tool = entry.tool;
    const line = toolLine(tool);
    return (
      <Box key={entry.id} flexDirection="column" marginBottom={marginBottom} paddingLeft={1}>
        <Text>
          <Text color={line.color} bold={tool.status === 'failed'}>
            {line.prefix}
          </Text>
          <Text color={line.color} dimColor={tool.status === 'succeeded'}>
            {` ${line.name}`}
          </Text>
          {line.detail === undefined ? null : <Text dimColor>{`  ${line.detail}`}</Text>}
          {line.stats === undefined
            ? null
            : line.stats.split(' ').map((part, index) => (
                <Text key={part} color={part.startsWith('+') ? 'green' : 'red'}>
                  {`${index === 0 ? '  ' : ' '}${part}`}
                </Text>
              ))}
        </Text>
        {tool.error !== undefined ? (
          <Box paddingLeft={2}>
            <Text color="red" wrap="wrap">
              {tool.error}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (entry.display === 'stats') {
    return <StatsView content={entry.content} marginBottom={marginBottom} />;
  }

  if (entry.display === 'diff') {
    return (
      <Box paddingLeft={2} flexDirection="column" marginBottom={marginBottom}>
        <DiffView content={entry.content} />
      </Box>
    );
  }

  return (
    <Box key={entry.id} marginBottom={marginBottom}>
      <Text color={entry.kind === 'error' ? 'red' : 'yellow'} wrap="wrap">
        {entry.content}
      </Text>
    </Box>
  );
}

// Line-based scrolling helpers. Scrolling by entry count made long messages
// jump past the viewport in one step and left it half-empty; counting the
// rendered lines instead keeps the viewport full and the steps predictable.
//
// Ink wraps Text with wrap-ansi using `{ trim: false, hard: true }`; the same
// options here keep the estimates and the clipped rendering aligned with the
// real layout: display-width aware (CJK characters count as two columns) and
// breaking at spaces instead of splitting words mid-way.

export function wrapToLines(text: string, width: number): string[] {
  if (width <= 0) return [];
  return wrapAnsi(text, width, { trim: false, hard: true }).split('\n');
}

export function assistantLines(content: string, width: number): string[] {
  return assistantRenderLines(content, width).map((line) => line.text);
}

interface AssistantRenderLine {
  text: string;
  code: boolean;
}

function assistantRenderLines(content: string, width: number): AssistantRenderLine[] {
  const rendered: AssistantRenderLine[] = [];
  let inCode = false;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.replace(/\s+$/u, '');
    if (inCode) {
      if (line.trimStart().startsWith('```')) {
        inCode = false;
        rendered.push({ text: '└────────', code: true });
      } else {
        rendered.push(...wrapToLines(line, width).map((text) => ({ text, code: true })));
      }
      continue;
    }
    if (/^\s*```/u.test(line)) {
      inCode = true;
      rendered.push({ text: '┌────────', code: true });
      continue;
    }
    if (line.length === 0) {
      rendered.push({ text: '', code: false });
      continue;
    }
    rendered.push(...wrapToLines(line, width).map((text) => ({ text, code: false })));
  }
  if (inCode) rendered.push({ text: '└────────', code: true });
  return rendered;
}

function estimateEntryLines(
  entry: TranscriptEntry,
  width: number,
  trailingGap = true,
  showThinking = false,
): number {
  const margin = trailingGap ? 1 : 0;
  // user/assistant bodies render inside a paddingLeft={2} box, so their
  // content area is two columns narrower than the transcript width; the
  // clipped renderer uses the same narrowed width to keep wrap positions
  // identical between the full view and the scrolled view.
  const bodyWidth = Math.max(1, width - 2);
  if (entry.kind === 'user') {
    return margin + 1 + wrapToLines(entry.content, bodyWidth).length;
  }
  if (entry.kind === 'assistant') {
    let body = entry.content.length === 0 ? 1 : assistantLines(entry.content, bodyWidth).length;
    if (showThinking && entry.reasoning !== undefined && entry.reasoning.length > 0) {
      body += thinkingLines(entry.reasoning, bodyWidth).length;
    }
    return margin + 1 + body;
  }
  if (entry.kind === 'tool' && entry.tool !== undefined) {
    let lines = 1;
    if (entry.tool.error !== undefined) {
      lines += wrapToLines(entry.tool.error, Math.max(1, width - 3)).length;
    }
    return margin + lines;
  }
  if (entry.display === 'diff') {
    return (
      margin +
      entry.content
        .split(/\r?\n/u)
        .reduce((total, line) => total + wrapToLines(line, bodyWidth).length, 0)
    );
  }
  return margin + wrapToLines(entry.content, width).length;
}

// Consecutive tool entries stack without blank lines between them; the helper
// keeps the line counts for scrolling in sync with that layout.
function entryTrailingGap(entries: TranscriptEntry[], index: number): boolean {
  const entry = entries[index];
  const next = entries[index + 1];
  return !(entry?.kind === 'tool' && next?.kind === 'tool');
}

function estimateEntriesLines(
  entries: TranscriptEntry[],
  width: number,
  showThinking = false,
): number {
  let total = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    total += estimateEntryLines(entry, width, entryTrailingGap(entries, index), showThinking);
  }
  return total;
}

// The transcript re-renders on every stream flush and spinner frame; memoising
// keeps the expensive wrap-ansi and Markdown re-parsing limited to entries
// that actually changed (unchanged entries keep their object identity, so the
// default shallow prop compare short-circuits the render).
function ClippedEntryImpl({
  entry,
  skip,
  take,
  width,
  trailingGap = true,
  showThinking = false,
}: {
  entry: TranscriptEntry;
  skip: number;
  take: number;
  width: number;
  trailingGap?: boolean;
  showThinking?: boolean;
}): React.ReactElement | null {
  if (take <= 0) return null;

  // Full render keeps markdown styling whenever the entry fits untouched.
  if (skip === 0) {
    const fullHeight = estimateEntryLines(entry, width, trailingGap, showThinking);
    if (take >= fullHeight)
      return (
        <EntryView
          entry={entry}
          trailingGap={trailingGap}
          showThinking={showThinking}
          width={width}
        />
      );
  }

  let remainingSkip = skip;
  let remainingTake = take;
  const rows: React.ReactElement[] = [];
  const takeLines = <T,>(
    lines: T[],
    render: (line: T, index: number) => React.ReactElement,
  ): void => {
    for (const line of lines) {
      if (remainingSkip > 0) {
        remainingSkip -= 1;
        continue;
      }
      if (remainingTake <= 0) return;
      rows.push(render(line, rows.length));
      remainingTake -= 1;
    }
  };

  if (entry.kind === 'user') {
    takeLines(['❯ you'], (line, index) => (
      <Text key={index} color="cyan" bold>
        {line}
      </Text>
    ));
    takeLines(wrapToLines(entry.content, Math.max(1, width - 2)), (line, index) => (
      <Text key={index} wrap="truncate-end">
        {`  ${line}`}
      </Text>
    ));
  } else if (entry.kind === 'assistant') {
    takeLines(['◆ codefarmer'], (line, index) => (
      <Text key={index} color="green" bold>
        {line}
      </Text>
    ));
    if (showThinking && entry.reasoning !== undefined && entry.reasoning.length > 0) {
      takeLines(thinkingLines(entry.reasoning, Math.max(1, width - 2)), (line, index) => (
        <Text
          key={`thinking-${String(index)}`}
          dimColor={index > 0}
          {...(index === 0 ? { color: 'magenta' as const } : {})}
          wrap="truncate-end"
        >
          {`  ${line}`}
        </Text>
      ));
    }
    if (entry.content.length === 0) {
      takeLines(['  …'], (line, index) => (
        <Text key={index} dimColor>
          {line}
        </Text>
      ));
    } else {
      takeLines(assistantRenderLines(entry.content, Math.max(1, width - 2)), (line, index) =>
        line.code ? (
          <Text key={index} color="gray" wrap="truncate-end">
            {`  ${line.text}`}
          </Text>
        ) : (
          <Box key={index} paddingLeft={2} flexDirection="column">
            <MarkdownLine line={line.text} />
          </Box>
        ),
      );
    }
  } else if (entry.kind === 'tool' && entry.tool !== undefined) {
    const tool = entry.tool;
    const line = toolLine(tool);
    const stats = line.stats === undefined ? '' : `  ${line.stats}`;
    takeLines(
      [`${line.prefix} ${line.name}${line.detail === undefined ? '' : `  ${line.detail}`}${stats}`],
      (text, index) => (
        <Text key={index} color={line.color} dimColor={tool.status === 'succeeded'}>
          {text}
        </Text>
      ),
    );
    if (tool.error !== undefined) {
      takeLines(wrapToLines(tool.error, Math.max(1, width - 3)), (line, index) => (
        <Text key={index} color="red" wrap="truncate-end">
          {`  ${line}`}
        </Text>
      ));
    }
  } else if (entry.display === 'stats') {
    const lines = entry.content.split('\n').flatMap((line) => wrapToLines(line, width));
    takeLines(lines, (line, index) => (
      <Text
        key={index}
        color={statsLineColor(line)}
        bold={line === 'Status' || line.startsWith('Tokens by model')}
        wrap="truncate-end"
      >
        {line}
      </Text>
    ));
  } else if (entry.display === 'diff') {
    const lines = entry.content.split(/\r?\n/u);
    takeLines(lines, (line, index) => {
      const color = diffLineColor(line);
      return (
        <Text
          key={index}
          {...(color === undefined ? {} : { color })}
          bold={color === 'cyan'}
          wrap="truncate-end"
        >
          {`  ${line}`}
        </Text>
      );
    });
  } else {
    takeLines(wrapToLines(entry.content, width), (line, index) => (
      <Text key={index} color={entry.kind === 'error' ? 'red' : 'yellow'} wrap="truncate-end">
        {line}
      </Text>
    ));
  }

  if (rows.length === 0) return null;
  return (
    <Box
      flexDirection="column"
      marginBottom={trailingGap ? 1 : 0}
      paddingLeft={entry.kind === 'tool' ? 1 : 0}
    >
      {rows}
    </Box>
  );
}

export const ClippedEntry = React.memo(ClippedEntryImpl);

export function ApprovalModal({
  approval,
  columns,
  rows,
}: {
  approval: ApprovalView;
  columns: number;
  rows: number;
}): React.ReactElement {
  const width = Math.max(1, Math.min(78, columns - 8));
  // Keep the approval card compact so it does not push the command deck out of view.
  const maximumHeight = Math.max(12, Math.min(16, rows - 6));
  const maximumLines = Math.max(1, maximumHeight - 11);
  const clipped = clipApprovalDetail(formatApprovalDetail(approval.request), width, maximumLines);
  const detailLabel = approval.request.kind === 'command' ? 'COMMAND' : 'FILE CHANGES';
  const description =
    approval.request.kind === 'command'
      ? 'This action can change or publish workspace state.'
      : 'Review the proposed file changes before applying them.';
  return (
    <Box
      width={width}
      maxHeight={maximumHeight}
      overflow="hidden"
      flexDirection="column"
      borderStyle="single"
      borderColor={BRAND_COLOR}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="space-between">
        <Text color="yellow" bold>
          {'!  Approval required'}
        </Text>
        <Text color="gray" bold>
          {approval.request.kind === 'command' ? 'PROTECTED ACTION' : 'WORKSPACE CHANGE'}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color="white" bold wrap="wrap">
          {approval.request.title}
        </Text>
        <Text dimColor wrap="wrap">
          {description}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1} paddingLeft={1}>
        <Text color="gray" bold>
          {detailLabel}
        </Text>
        <Text color="cyan" wrap="wrap">
          {clipped}
        </Text>
      </Box>
      <Text color="gray">{'─'.repeat(Math.max(1, Math.min(56, width - 6)))}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{'Allow for:'}</Text>
        <Box flexDirection="row" flexWrap="wrap">
          <Text color="green" bold>
            {'[Y]'}
          </Text>
          <Text>{' once   '}</Text>
          <Text color="cyan" bold>
            {'[S]'}
          </Text>
          <Text>{' this session   '}</Text>
          <Text color="magenta" bold>
            {'[W]'}
          </Text>
          <Text>{' this workspace'}</Text>
        </Box>
        <Text color="red">
          <Text bold>{'[Enter / N]'}</Text>
          {' deny'}
        </Text>
      </Box>
    </Box>
  );
}

// Interactive picker summoned by a bare `/effort` (no argument): the user
// adjusts the effort level with ←/→, confirms with Enter, and closes with
// Esc (Ctrl+C works too) without changing anything.
//
// Claude Code 式横向滑轨：渲染在输入框上方的文档流中，选项标签排成一行，
// ▲ 游标精确落在选中项正下方，不悬浮遮挡内容，也不会跑出可视区域。
export function EffortPicker({
  current,
  selected,
  language = 'en',
}: {
  current: ReasoningEffort;
  selected: number;
  language?: Language;
}): React.ReactElement {
  const gap = '   ';
  const zh = language === 'zh-CN';
  // 选项名均为 ASCII，字符串长度即显示宽度；累加前序选项宽度算出 ▲ 的
  // 前导缩进，使游标对准选中标签的中点。
  let markerPad = 0;
  for (let index = 0; index < selected; index += 1) {
    markerPad += (EFFORT_CHOICES[index] ?? '').length + gap.length;
  }
  const chosen = EFFORT_CHOICES[selected] ?? 'none';
  markerPad += Math.floor(chosen.length / 2);
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="blue">
      <Box flexDirection="row">
        <Text color="cyan" bold>
          REASONING EFFORT
        </Text>
        <Text dimColor>
          {zh ? '  思考深度（当前 ' : '  Effort (current '}
          <Text color={EFFORT_COLORS[current]}>{current}</Text>
          {zh ? '）' : ')'}
        </Text>
      </Box>
      <Box flexDirection="row">
        {EFFORT_CHOICES.map((choice, index) => (
          <Text
            key={choice}
            color={EFFORT_COLORS[choice]}
            dimColor={index !== selected}
            bold={index === selected}
          >
            {choice + (index < EFFORT_CHOICES.length - 1 ? gap : '')}
          </Text>
        ))}
      </Box>
      <Text color={EFFORT_COLORS[chosen]}>{' '.repeat(markerPad)}▲</Text>
      <Text dimColor>
        {zh ? '←/→ 调整 · Enter 确认 · Esc 取消' : '←/→ adjust · Enter confirm · Esc cancel'}
      </Text>
    </Box>
  );
}

export function TuiApp({
  initialRuntime,
  runtimeFactory,
  bridge,
  initialPlanMode = false,
  initialShowThinking = false,
  onTerminalTitleChange,
}: TuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [runtime, setRuntime] = useState(initialRuntime);
  const runtimeRef = useRef(initialRuntime);
  const [entries, setEntries] = useState<TranscriptEntry[]>(() =>
    runtimeEntriesWithWelcome(initialRuntime),
  );
  const [draft, setDraft] = useState('');
  const [cursor, setCursor] = useState(0);
  // Refs are the source of truth for the input buffer: Ink can deliver
  // several key events between renders, and state captured in the useInput
  // closure would be stale, dropping characters when typing fast.
  const draftRef = useRef('');
  const cursorRef = useRef(0);
  const applyDraft = useCallback((value: string, position: number): void => {
    draftRef.current = value;
    cursorRef.current = position;
    setDraft(value);
    setCursor(position);
  }, []);
  const [busy, setBusy] = useState(false);
  // React state may lag behind key events by one render. This ref is the
  // synchronous lock for model turns and prevents local commands from
  // accidentally starting a second turn or clearing the active one.
  const busyRef = useRef(false);
  const [status, setStatus] = useState(
    initialRuntime.config.language === 'zh-CN' ? '就绪' : 'Ready',
  );
  const [language, setLanguage] = useState<'en' | 'zh-CN'>(initialRuntime.config.language);
  const languageRef = useRef<'en' | 'zh-CN'>(initialRuntime.config.language);
  const [agentMode, setAgentMode] = useState<AgentMode>(initialPlanMode ? 'plan' : 'auto');
  const agentModeRef = useRef<AgentMode>(initialPlanMode ? 'plan' : 'auto');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  // Ctrl+O 切换：是否在助手消息上方展示推理摘要（思考过程）。
  const [showThinking, setShowThinking] = useState(initialShowThinking);
  const [usage, setUsage] = useState<TokenUsage>(initialRuntime.session?.usage ?? EMPTY_USAGE);
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  // Effort picker state: null when closed, otherwise the index of the
  // highlighted effort level. Opened by a bare `/effort`, adjusted with
  // ←/→, confirmed with Enter, dismissed with Esc (or Ctrl+C).
  const [effortPicker, setEffortPicker] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const approvalQueueRef = useRef<PendingApproval[]>([]);
  const currentApprovalRef = useRef<PendingApproval | undefined>(undefined);
  // Last reasoning effort the model reported; the UI tells the user whenever
  // the agent picks ('auto') or switches its own thinking depth mid-session.
  const lastReasoningEffortRef = useRef<ReasoningEffort | undefined>(undefined);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  // Transcript scroll position in rendered lines from the top; -1 = pinned to the latest message.
  const [topLine, setTopLine] = useState(-1);
  // Stream deltas arrive many times per second; batching them into one state
  // update per interval keeps Ink from re-rendering on every single delta.
  // Text deltas and reasoning (thinking) deltas share the same buffer flush.
  const deltaBufferRef = useRef('');
  const reasoningBufferRef = useRef('');
  const deltaFlushTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const flushDeltaBuffer = useCallback((assistantId: string): void => {
    if (deltaFlushTimerRef.current !== undefined) {
      clearInterval(deltaFlushTimerRef.current);
      deltaFlushTimerRef.current = undefined;
    }
    const buffered = deltaBufferRef.current;
    const reasoning = reasoningBufferRef.current;
    if (buffered.length === 0 && reasoning.length === 0) return;
    deltaBufferRef.current = '';
    reasoningBufferRef.current = '';
    setEntries((previous) =>
      previous.map((entry) =>
        entry.id === assistantId
          ? {
              ...entry,
              ...(buffered.length === 0 ? {} : { content: `${entry.content}${buffered}` }),
              ...(reasoning.length === 0
                ? {}
                : { reasoning: `${entry.reasoning ?? ''}${reasoning}` }),
            }
          : entry,
      ),
    );
  }, []);

  useEffect(() => {
    onTerminalTitleChange?.(formatTerminalTitle(runtime.session?.title));
  }, [onTerminalTitleChange, runtime.session?.title]);

  const pumpApproval = useCallback(() => {
    if (currentApprovalRef.current !== undefined) return;
    const next = approvalQueueRef.current.shift();
    if (next === undefined) return;
    currentApprovalRef.current = next;
    setApproval({ request: next.request });
  }, []);

  const requestApprovalDecision = useCallback(
    (request: ApprovalRequest): Promise<ApprovalDecision> =>
      new Promise((resolve) => {
        approvalQueueRef.current.push({ request, resolve });
        pumpApproval();
      }),
    [pumpApproval],
  );

  const requestApproval = useCallback(
    async (request: ApprovalRequest): Promise<boolean> =>
      (await requestApprovalDecision(request)).approved,
    [requestApprovalDecision],
  );

  const resolveApproval = useCallback(
    (decision: ApprovalDecision): void => {
      const current = currentApprovalRef.current;
      if (current === undefined) return;
      currentApprovalRef.current = undefined;
      setApproval(null);
      current.resolve(decision);
      pumpApproval();
    },
    [pumpApproval],
  );

  useEffect(() => {
    bridge.setApprovalHandler(requestApproval);
    bridge.setApprovalDecisionHandler(requestApprovalDecision);
    return () => {
      bridge.setApprovalHandler(undefined);
      bridge.setApprovalDecisionHandler(undefined);
      const current = currentApprovalRef.current;
      currentApprovalRef.current = undefined;
      current?.resolve({ approved: false, scope: 'once' });
      for (const pending of approvalQueueRef.current.splice(0)) {
        pending.resolve({ approved: false, scope: 'once' });
      }
    };
  }, [bridge, requestApproval]);

  const handleToolEvent = useCallback((event: TuiToolEvent): void => {
    if (event.type === 'tool_start' && event.call !== undefined) {
      const call = event.call;
      const tool: ToolView = {
        callId: call.callId,
        name: call.name,
        status: 'running',
        arguments: call.arguments,
      };
      setEntries((previous) => {
        const index = previous.findIndex((entry) => entry.tool?.callId === call.callId);
        if (index < 0) {
          return [
            ...previous,
            { id: `tool-${call.callId}`, kind: 'tool', content: call.name, tool },
          ];
        }
        const next = [...previous];
        const existing = next[index];
        if (existing === undefined) return previous;
        next[index] = { ...existing, tool, content: call.name };
        return next;
      });
      setStatus(`Running ${call.name}`);
      return;
    }
    if (event.type === 'tool_result' && event.call !== undefined && event.result !== undefined) {
      const callId = event.call.callId;
      const result = event.result;
      setEntries((previous) => {
        const index = previous.findIndex((entry) => entry.tool?.callId === callId);
        const old = index < 0 ? undefined : previous[index]?.tool;
        const tool: ToolView = {
          callId,
          name: event.call?.name ?? result.toolName,
          status: result.success ? 'succeeded' : 'failed',
          ...(old?.arguments === undefined ? {} : { arguments: old.arguments }),
          ...(result.success
            ? { output: toolOutputPreview(formatToolResult(result)) }
            : { error: formatToolResult(result) }),
          ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
        };
        if (index < 0) {
          return [...previous, { id: `tool-${callId}`, kind: 'tool', content: tool.name, tool }];
        }
        const next = [...previous];
        const existing = next[index];
        if (existing === undefined) return previous;
        next[index] = { ...existing, tool, content: tool.name };
        return next;
      });
      setStatus(result.success ? 'Tool completed' : 'Tool failed');
    }
  }, []);

  useEffect(() => {
    bridge.setToolEventHandler(handleToolEvent);
    return () => bridge.setToolEventHandler(undefined);
  }, [bridge, handleToolEvent]);

  const appendSystem = useCallback(
    (content: string, kind: 'system' | 'error' = 'system', display?: 'stats' | 'diff'): void => {
      setEntries((previous) => [
        ...previous,
        { id: id(kind), kind, content, ...(display === undefined ? {} : { display }) },
      ]);
    },
    [],
  );

  const setMode = useCallback(
    (mode: AgentMode): void => {
      agentModeRef.current = mode;
      setAgentMode(mode);
      appendSystem(
        mode === 'plan'
          ? 'Plan mode enabled: read-only research, no edits.'
          : mode === 'auto'
            ? 'Auto mode enabled: the agent will plan, execute, and auto-approve ordinary operations.'
            : 'Code mode enabled: ordinary mutations require the configured approval policy.',
      );
    },
    [appendSystem],
  );

  const cycleAgentMode = useCallback((): void => {
    setMode(nextAgentMode(agentModeRef.current));
  }, [setMode]);

  const swapRuntime = useCallback((next: AgentRuntime): void => {
    runtimeRef.current = next;
    setRuntime(next);
    setEntries(runtimeEntries(next));
    setUsage(next.session?.usage ?? EMPTY_USAGE);
    setStatus(next.config.language === 'zh-CN' ? '就绪' : 'Ready');
    setTopLine(-1);
    setSelectedSkills([]);
    languageRef.current = next.config.language;
    setLanguage(next.config.language);
  }, []);

  interface RunPromptOptions {
    /** Run against an ephemeral session so the turn is not recorded in history. */
    ephemeral?: boolean;
    /** Force plan (read-only) mode for this turn. */
    plan?: boolean;
    /** Called from inside `runCommand`, which already manages the busy state. */
    nested?: boolean;
  }

  // Returns the agent run result, or undefined when the turn failed to run
  // (the error is already surfaced as a transcript entry by the catch path).
  const runPrompt = useCallback(
    async (
      prompt: string,
      displayPrompt = prompt,
      options?: RunPromptOptions,
    ): Promise<AgentRunResult | undefined> => {
      const nested = options?.nested === true;
      const assistantId = id('assistant');
      // A run may contain several model responses separated by tool calls.
      // Keep each response in its own transcript entry instead of appending
      // every streamed delta to the placeholder created for the whole run.
      const activeAssistant: { id: string | undefined; hasOutput: boolean } = {
        id: assistantId,
        hasOutput: false,
      };
      const ensureAssistantEntry = (): string => {
        if (activeAssistant.id !== undefined) return activeAssistant.id;
        const nextAssistantId = id('assistant');
        activeAssistant.id = nextAssistantId;
        setEntries((previous) => [
          ...previous,
          { id: nextAssistantId, kind: 'assistant', content: '' },
        ]);
        return nextAssistantId;
      };
      setEntries((previous) => [
        ...previous,
        { id: id('user'), kind: 'user', content: displayPrompt },
        { id: assistantId, kind: 'assistant', content: '' },
      ]);
      if (!nested) {
        busyRef.current = true;
        setBusy(true);
      }
      setStatus('Thinking');
      const controller = new AbortController();
      controllerRef.current = controller;
      const activeRuntime = runtimeRef.current;
      const handleProviderEvent = (event: ProviderEvent): void => {
        if (event.type === 'text_delta') {
          const currentAssistantId = ensureAssistantEntry();
          activeAssistant.hasOutput ||= event.delta.length > 0;
          deltaBufferRef.current += event.delta;
          deltaFlushTimerRef.current ??= setInterval(
            () => flushDeltaBuffer(currentAssistantId),
            60,
          );
        } else if (event.type === 'reasoning_delta') {
          const currentAssistantId = ensureAssistantEntry();
          activeAssistant.hasOutput ||= event.delta.length > 0;
          reasoningBufferRef.current += event.delta;
          deltaFlushTimerRef.current ??= setInterval(
            () => flushDeltaBuffer(currentAssistantId),
            60,
          );
        } else if (event.type === 'reasoning_effort') {
          const previous = lastReasoningEffortRef.current;
          lastReasoningEffortRef.current = event.effort;
          if (previous === undefined)
            appendSystem(`The model chose reasoning effort ${event.effort}.`);
          else if (previous !== event.effort)
            appendSystem(
              `The model switched reasoning effort from ${previous} to ${event.effort}.`,
            );
        } else if (
          event.type === 'response_completed' &&
          event.outputText !== undefined &&
          event.outputText.length > 0 &&
          !activeAssistant.hasOutput
        ) {
          const currentAssistantId = ensureAssistantEntry();
          activeAssistant.hasOutput = true;
          deltaBufferRef.current += event.outputText;
          deltaFlushTimerRef.current ??= setInterval(
            () => flushDeltaBuffer(currentAssistantId),
            60,
          );
        } else if (event.type === 'usage') {
          setUsage(event.usage);
        } else if (event.type === 'compacted') {
          appendSystem(event.message);
        } else if (event.type === 'tool_call') {
          const currentAssistantId = activeAssistant.id;
          if (currentAssistantId !== undefined) flushDeltaBuffer(currentAssistantId);
          activeAssistant.id = undefined;
          activeAssistant.hasOutput = false;
          const call = event.call;
          const tool: ToolView = {
            callId: call.callId,
            name: call.name,
            status: 'requested',
            arguments: call.arguments,
          };
          setEntries((previous) => {
            if (previous.some((entry) => entry.tool?.callId === call.callId)) return previous;
            return appendToolEntryAtResponseBoundary(
              previous,
              currentAssistantId,
              activeAssistant.hasOutput,
              { id: `tool-${call.callId}`, kind: 'tool', content: call.name, tool },
            );
          });
          setStatus(`Preparing ${call.name}`);
        }
      };
      let unsubscribe: (() => void) | undefined;
      try {
        const turnPlan = options?.plan === true || agentModeRef.current === 'plan';
        const turnAuto = options?.plan !== true && agentModeRef.current === 'auto';
        let result: AgentRunResult;
        if (activeRuntime.orchestrator !== undefined && options?.ephemeral !== true) {
          const queued = activeRuntime.orchestrator.enqueue(prompt, {
            displayPrompt,
            ...(turnPlan ? { plan: true } : {}),
            ...(turnAuto ? { auto: true } : {}),
            ...(selectedSkills.length === 0 ? {} : { skills: selectedSkills }),
          });
          unsubscribe = activeRuntime.orchestrator.subscribe((event) => {
            if (event.type === 'provider_event' && event.turn.id === queued.turn.id) {
              handleProviderEvent(event.event);
            }
            if (event.type === 'turn_started' && event.turn.id === queued.turn.id)
              setStatus('Thinking');
            if (
              event.type === 'turn_queued' &&
              event.turn.id === queued.turn.id &&
              event.position > 1
            ) {
              setStatus(`Queued (${String(event.position - 1)} ahead)`);
            }
          });
          result = await queued.promise;
        } else {
          result = await activeRuntime.runner.run(prompt, {
            ...(options?.ephemeral === true || activeRuntime.session === undefined
              ? {}
              : { session: activeRuntime.session }),
            history: options?.ephemeral === true ? false : true,
            signal: controller.signal,
            ...(turnPlan ? { plan: true } : {}),
            ...(turnAuto ? { auto: true } : {}),
            ...(selectedSkills.length === 0 ? {} : { skills: selectedSkills }),
            onEvent: handleProviderEvent,
          });
        }
        if (activeAssistant.id !== undefined) flushDeltaBuffer(activeAssistant.id);
        setUsage(result.usage);
        setEntries((previous) => {
          if (result.message.length === 0) return previous;
          const assistantIndex =
            activeAssistant.id === undefined
              ? -1
              : previous.findIndex((entry) => entry.id === activeAssistant.id);
          if (assistantIndex < 0) {
            return [
              ...previous,
              { id: id('assistant'), kind: 'assistant', content: result.message },
            ];
          }
          const assistant = previous[assistantIndex];
          if (assistant === undefined) return previous;
          const next = [...previous];
          next[assistantIndex] = { ...assistant, content: result.message };
          return next;
        });
        setStatus(result.status === 'cancelled' ? 'Cancelled' : 'Ready');
        if (!nested && activeRuntime.session !== undefined) {
          const session = activeRuntime.session;
          const contextChars = sessionContextChars(session);
          if (
            contextChars >= COMPACT_HINT_MIN_CHARS ||
            session.messages.length >= COMPACT_HINT_MIN_MESSAGES
          ) {
            appendSystem(
              `Tip: the conversation is now ${String(session.messages.length)} messages / ` +
                `${String(contextChars)} chars. Run /compact to compress the early part ` +
                'into a summary and reduce context cost.',
            );
          }
        }
        return result;
      } catch (error) {
        if (activeAssistant.id !== undefined) flushDeltaBuffer(activeAssistant.id);
        appendSystem(displayError(error), 'error');
        setStatus('Error');
        return undefined;
      } finally {
        unsubscribe?.();
        if (deltaFlushTimerRef.current !== undefined) {
          clearInterval(deltaFlushTimerRef.current);
          deltaFlushTimerRef.current = undefined;
        }
        controllerRef.current = undefined;
        if (!nested) {
          const currentState = activeRuntime.orchestrator?.snapshot().state;
          const stillBusy = currentState !== undefined && currentState !== 'idle';
          busyRef.current = stillBusy;
          setBusy(stillBusy);
        }
      }
    },
    [appendSystem, flushDeltaBuffer, selectedSkills],
  );

  const runCommand = useCallback(
    async (command: TuiCommand): Promise<void> => {
      if (command.kind === 'prompt') {
        if (command.value.length > 0) await runPrompt(command.value);
        return;
      }
      if (command.kind === 'quit') {
        runtimeRef.current.orchestrator?.cancelActive();
        controllerRef.current?.abort();
        exit();
        return;
      }
      if (command.kind === 'cancel') {
        const cancelled = runtimeRef.current.orchestrator?.cancelActive() ?? false;
        if (cancelled || controllerRef.current !== undefined) {
          controllerRef.current?.abort();
          setStatus('Cancelling');
        } else {
          appendSystem('No active turn.');
        }
        return;
      }
      if (command.kind === 'init') {
        // /init delegates the workspace summary to the agent so AGENT.md is
        // based on verified repository facts and uses normal write approvals.
        await runPrompt(INIT_AGENT_PROMPT, '/init');
        return;
      }
      // 只读命令在思考期间也可用；输入框不再被占用。
      const modelTurnActive = busyRef.current;
      if (modelTurnActive && !canRunWhileBusy(command)) return;
      const commandName = command.kind === 'delete-session' ? 'delete' : command.kind;
      setEntries((previous) => [
        ...previous,
        { id: id('command'), kind: 'user', content: `/${commandName}` },
      ]);
      if (!modelTurnActive) {
        busyRef.current = true;
        setBusy(true);
      }
      try {
        if (command.kind === 'help') {
          appendSystem(getTuiHelp(languageRef.current));
        } else if (command.kind === 'skills') {
          const skills = runtimeRef.current.skills;
          appendSystem(
            skills === undefined ? 'No skill catalog is available.' : formatSkillCatalog(skills),
          );
        } else if (command.kind === 'skill') {
          if (command.ref.length === 0) {
            appendSystem(
              selectedSkills.length === 0
                ? 'Usage: /skill <ref> | /skill off'
                : `Selected skills: ${selectedSkills.join(', ')}`,
            );
          } else if (command.ref === 'off') {
            setSelectedSkills([]);
            appendSystem('Cleared selected skills.');
          } else if (runtimeRef.current.skills?.get(command.ref) === undefined) {
            appendSystem(
              `Unknown skill: ${command.ref}. Run /skills to list available skills.`,
              'error',
            );
          } else {
            setSelectedSkills((previous) =>
              previous.includes(command.ref) ? previous : [...previous, command.ref],
            );
            appendSystem(`Selected skill ${command.ref}.`);
          }
        } else if (command.kind === 'new') {
          const next = await runtimeFactory();
          swapRuntime(next);
          appendSystem(`New session ${next.session?.id ?? ''}`);
        } else if (command.kind === 'resume') {
          if (command.id.length === 0) appendSystem('Usage: /resume <session-id>', 'error');
          else {
            const next = await runtimeFactory(command.id);
            swapRuntime(next);
            appendSystem(`Resumed session ${next.session?.id ?? command.id}`);
          }
        } else if (command.kind === 'status') {
          const active = runtimeRef.current;
          const availability = await detectGitAvailability();
          let gitLine = 'not installed (optional; Git tools disabled)';
          if (availability.available) {
            const git = await execa(
              'git',
              ['-c', 'core.fsmonitor=false', 'status', '--short', '--branch', '--', '.'],
              {
                cwd: active.workspace,
                reject: false,
                env: { GIT_OPTIONAL_LOCKS: '0' },
              },
            );
            gitLine = git.exitCode === 0 ? git.stdout || 'clean' : 'not a Git workspace';
          }
          appendSystem(
            [
              `Workspace  ${active.workspace}`,
              `Session    ${active.session?.id ?? 'none'}`,
              `Model      ${active.config.model} (${active.config.reasoning}, ${active.config.verbosity})`,
              `Reasoning  summary ${active.config.reasoningSummary}`,
              `Mode       ${agentModeRef.current.toUpperCase()}`,
              `Approval   ${agentModeRef.current === 'auto' ? 'auto (protected operations still confirm)' : active.config.approval}`,
              `Skills     ${selectedSkills.length === 0 ? 'none selected' : selectedSkills.join(', ')}`,
              `Base URL   ${active.config.baseURL}`,
              `Git        ${gitLine}`,
            ].join('\n'),
          );
        } else if (command.kind === 'stats') {
          const sessions = await runtimeRef.current.sessions.list();
          appendSystem(formatWorkspaceStats(computeWorkspaceStats(sessions)), 'system', 'stats');
        } else if (command.kind === 'context') {
          const active = runtimeRef.current;
          const session = active.session;
          const messages = session?.messages ?? [];
          const lines: string[] = [
            `Session    ${session?.id ?? 'none'}`,
            `Model      ${active.config.model} (${active.config.reasoning}, ${active.config.verbosity})`,
            `Messages   ${formatNumber(messages.length)} | Tool calls ${formatNumber(session?.toolCalls.length ?? 0)}`,
          ];
          if (messages.length === 0) {
            lines.push('Context    empty');
          } else {
            const contextChars = messages.reduce((sum, message) => sum + message.content.length, 0);
            const contextTokens = messages.reduce(
              (sum, message) => sum + estimateContextTokens(message.content),
              0,
            );
            const ratio = Math.min(1, contextTokens / ESTIMATED_CONTEXT_WINDOW_TOKENS);
            lines.push(
              `Context    ${usageBar(ratio)} ${formatNumber(contextTokens)} / ${formatNumber(ESTIMATED_CONTEXT_WINDOW_TOKENS)} tokens ≈ ${(ratio * 100).toFixed(1)}%`,
              `           ${formatNumber(contextChars)} chars across ${formatNumber(messages.length)} messages`,
            );
            const roleChars = new Map<string, number>();
            let largestChars = 0;
            let largestIndex = -1;
            messages.forEach((message, index) => {
              roleChars.set(
                message.role,
                (roleChars.get(message.role) ?? 0) + message.content.length,
              );
              if (message.content.length > largestChars) {
                largestChars = message.content.length;
                largestIndex = index;
              }
            });
            const roleSummary = [...roleChars.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(
                ([role, chars]) =>
                  `${role} ${formatNumber(chars)} (${String(Math.round((chars / contextChars) * 100))}%)`,
              )
              .join(' | ');
            lines.push(`Roles      ${roleSummary}`);
            messages.forEach((message, index) => {
              const marker = index === largestIndex ? ' ← largest' : '';
              lines.push(
                `  ${String(index + 1).padStart(2, ' ')}. ${message.role.padEnd(9, ' ')} ${formatNumber(message.content.length).padStart(9, ' ')} chars${marker}  ${previewLine(message.content)}`,
              );
            });
            if (
              contextChars >= COMPACT_HINT_MIN_CHARS ||
              messages.length >= COMPACT_HINT_MIN_MESSAGES
            ) {
              lines.push('Tip        Run /compact to compress the early messages into a summary.');
            }
          }
          lines.push(
            `Tokens     in ${formatNumber(usage.inputTokens)} / out ${formatNumber(usage.outputTokens)} / total ${formatNumber(usage.totalTokens)}`,
          );
          if (usage.cachedInputTokens !== undefined) {
            lines.push(`           cached ${formatNumber(usage.cachedInputTokens)}`);
          }
          if (usage.reasoningTokens !== undefined) {
            lines.push(`           reasoning ${formatNumber(usage.reasoningTokens)}`);
          }
          appendSystem(lines.join('\n'));
        } else if (command.kind === 'compact') {
          const active = runtimeRef.current;
          const session = active.session;
          if (session === undefined) {
            appendSystem('No active session; start one with /new or /resume.', 'error');
          } else if (session.messages.length <= COMPACT_KEEP_RECENT_MESSAGES + 1) {
            appendSystem(
              `Session has only ${String(session.messages.length)} messages; nothing to compress ` +
                `yet (at least ${String(COMPACT_KEEP_RECENT_MESSAGES + 1)} are needed).`,
              'error',
            );
          } else {
            const beforeChars = sessionContextChars(session);
            const result = await active.runner.compact(session);
            // The session was mutated in place; re-render the transcript from
            // the compressed session so the hidden early turns disappear.
            setRuntime({ ...active });
            setEntries(runtimeEntries(active));
            appendSystem(
              [
                `Compacted ${String(result.compressedMessageCount)} of ${String(result.originalMessageCount)} messages into a summary; ` +
                  `kept the last ${String(result.keptMessageCount)} verbatim.`,
                `Context ${String(beforeChars)} → ${String(sessionContextChars(session))} chars.`,
                `Summary ${String(result.summary.length)} chars; ` +
                  `tokens in ${String(result.usage.inputTokens)} / out ${String(result.usage.outputTokens)}.`,
              ].join('\n'),
            );
          }
        } else if (command.kind === 'effort') {
          // Open the interactive picker; the selected level is applied on
          // Enter (see the effortPicker branch in useInput).
          const index = EFFORT_CHOICES.indexOf(runtimeRef.current.config.reasoning);
          setEffortPicker(index < 0 ? 0 : index);
        } else if (command.kind === 'model') {
          const nextModel = command.value.trim();
          const active = runtimeRef.current;
          if (nextModel.length === 0) {
            appendSystem(`Current model: ${active.config.model}\nUsage: /model <model-name>`);
          } else if (nextModel === active.config.model) {
            appendSystem(`Model is already set to ${nextModel}.`);
          } else {
            active.config.model = nextModel;
            if (active.session !== undefined) {
              active.session.model = nextModel;
              await active.sessions.save(active.session);
            }
            setRuntime({ ...active });
            appendSystem(`Model set to ${nextModel} for this session.`);
          }
        } else if (command.kind === 'plan') {
          if (command.value.length === 0) {
            setMode(agentModeRef.current === 'plan' ? 'code' : 'plan');
          } else if (command.value === 'on') {
            setMode('plan');
          } else if (command.value === 'off') {
            setMode('code');
          } else {
            appendSystem(`Invalid plan mode "${command.value}". Choices: on | off`, 'error');
          }
        } else if (command.kind === 'auto') {
          if (command.value.length === 0) {
            setMode(agentModeRef.current === 'auto' ? 'code' : 'auto');
          } else if (command.value === 'on') {
            setMode('auto');
          } else if (command.value === 'off') {
            setMode('code');
          } else {
            appendSystem(`Invalid auto mode "${command.value}". Choices: on | off`, 'error');
          }
        } else if (command.kind === 'language') {
          if (command.value.length === 0) {
            appendSystem(
              languageRef.current === 'zh-CN'
                ? '当前语言：简体中文。用法：/language <en|zh-CN>'
                : 'Current language: English. Usage: /language <en|zh-CN>',
            );
          } else {
            const nextLanguage = normaliseLanguage(command.value);
            if (nextLanguage === undefined) {
              appendSystem(
                languageRef.current === 'zh-CN'
                  ? '不支持的语言。可选：en（English）或 zh-CN（简体中文）。'
                  : 'Unsupported language. Choices: en (English) or zh-CN.',
                'error',
              );
            } else {
              const active = runtimeRef.current;
              active.config.language = nextLanguage;
              languageRef.current = nextLanguage;
              setLanguage(nextLanguage);
              setStatus(nextLanguage === 'zh-CN' ? '就绪' : 'Ready');
              setRuntime({ ...active });
              appendSystem(
                nextLanguage === 'zh-CN'
                  ? '语言已切换为简体中文（仅当前会话；使用 `codefarmer language zh-CN` 可持久化）。'
                  : 'Language switched to English for this session (use `codefarmer language en` to persist).',
              );
            }
          }
        } else if (command.kind === 'config') {
          appendSystem(JSON.stringify(runtimeRef.current.config, null, 2));
        } else if (command.kind === 'doctor') {
          const active = runtimeRef.current;
          const checks: string[] = [];
          const major = Number(process.versions.node.split('.')[0]);
          checks.push(`${major >= 22 ? 'OK ' : 'ERR'} Node.js ${process.version}`);
          try {
            await access(active.workspace, constants.R_OK | constants.W_OK);
            checks.push(`OK  Workspace ${active.workspace}`);
          } catch (error) {
            checks.push(`ERR Workspace ${displayError(error)}`);
          }
          try {
            const git = await detectGitAvailability();
            checks.push(
              git.available
                ? `OK  Git ${git.version ?? ''} (optional)`
                : 'WARN Git is not available on PATH (optional; Git tools are disabled)',
            );
          } catch {
            checks.push('WARN Git is not available on PATH (optional; Git tools are disabled)');
          }
          checks.push(
            `OK  OPENAI_API_KEY ${
              process.env.OPENAI_API_KEY
                ? 'is set via environment'
                : 'is resolved from local credentials'
            }`,
          );
          checks.push(`INFO Model ${active.config.model}`);
          checks.push(`INFO Base URL ${active.config.baseURL}`);
          appendSystem(checks.join('\n'));
        } else if (command.kind === 'sessions') {
          const sessions = await runtimeRef.current.sessions.list();
          appendSystem(
            sessions.length === 0
              ? 'No saved sessions.'
              : sessions
                  .slice(0, 12)
                  .map(
                    (session) =>
                      `${session.id}  ${session.status}  ${session.title ?? '(untitled)'}  ${session.updatedAt}  ${String(session.messages.length)} messages`,
                  )
                  .join('\n'),
          );
        } else if (command.kind === 'delete-session') {
          if (command.id.length === 0) {
            appendSystem('Usage: /delete <session-id>', 'error');
          } else if (command.id === runtimeRef.current.session?.id) {
            appendSystem('The active session cannot be deleted.', 'error');
          } else {
            await runtimeRef.current.sessions.delete(command.id);
            appendSystem(`Deleted session ${command.id}`);
          }
        } else if (command.kind === 'diff') {
          if (!(await detectGitAvailability()).available) {
            appendSystem(
              'Git is not installed or not on PATH; /diff is unavailable (Git is optional).',
            );
          } else {
            const result = await execa(
              'git',
              [
                '--no-pager',
                '-c',
                'core.fsmonitor=false',
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                '--',
                '.',
              ],
              {
                cwd: runtimeRef.current.workspace,
                reject: false,
                env: { GIT_EXTERNAL_DIFF: '', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
              },
            );
            if (result.exitCode !== 0) {
              appendSystem(result.stderr.trim() || 'Unable to show the Git diff.');
            } else {
              appendSystem(result.stdout || '(no diff)', 'system', 'diff');
            }
          }
        } else if (command.kind === 'commit') {
          const workspace = runtimeRef.current.workspace;
          let message = command.message.trim();
          if (message.length === 0) {
            // 没有显式提交信息时，先让 agent 基于工作区差异自己总结提交信息；
            // 总结轮次只读（plan）且不入会话历史，只把结果用于 commit。
            const inspection = await inspectWorkingTree(workspace);
            if (inspection.status === 'dirty') {
              const summary = await runPrompt(
                COMMIT_SUMMARY_PROMPT,
                '/commit — agent 总结提交信息',
                { ephemeral: true, plan: true, nested: true },
              );
              if (summary === undefined) {
                appendSystem('Commit skipped: the agent could not summarize the changes.', 'error');
                return;
              }
              if (summary.status === 'cancelled') {
                appendSystem('Commit cancelled.', 'error');
                return;
              }
              message = extractCommitMessage(summary.message);
            }
          }
          const result = await commitWorkspaceChanges({
            workspace,
            message,
          });
          if (result.status === 'committed') {
            appendSystem(
              `Committed ${result.hash}: ${result.message}\n  ${result.files.join(', ')}`,
            );
          } else if (result.status === 'clean') {
            appendSystem('Nothing to commit; the working tree is clean.');
          } else if (result.status === 'not-a-repository') {
            appendSystem(
              'The workspace is not a Git repository; /commit is unavailable here.',
              'error',
            );
          } else {
            appendSystem(
              'Git is not installed or not on PATH; /commit is unavailable (Git is optional).',
            );
          }
        } else if (command.kind === 'push') {
          if (command.args.length > 0) {
            appendSystem('Usage: /push', 'error');
            return;
          }
          if (!(await detectGitAvailability()).available) {
            appendSystem(
              'Git is not installed or not on PATH; /push is unavailable (Git is optional).',
              'error',
            );
            return;
          }
          const preview = await previewCurrentBranchPush(runtimeRef.current.workspace);
          if (preview.ahead.length === 0) {
            appendSystem(
              `Nothing to push; ${preview.branch} is up to date with ${preview.upstream}.`,
            );
            return;
          }
          appendSystem(
            [
              `Push ${preview.branch} to ${preview.remote}`,
              `Upstream  ${preview.upstream}`,
              `Commits   ${String(preview.ahead.length)}`,
              ...preview.ahead.map((line) => `  ${line}`),
            ].join('\n'),
          );
          const pushArgs = ['push', preview.remote, preview.branch];
          const approved = await requestApproval({
            kind: 'command',
            title: 'Push Git changes',
            detail: JSON.stringify(['git', ...pushArgs]),
            readOnly: false,
            requireConfirmation: true,
          });
          if (!approved) {
            appendSystem('Push cancelled.');
            return;
          }
          const result = await execa('git', pushArgs, {
            ...pushGitOptions(runtimeRef.current.workspace),
          });
          if (result.exitCode !== 0) {
            appendSystem(result.stderr.trim() || 'Git push failed.', 'error');
          } else {
            appendSystem(`Pushed ${preview.branch} to ${preview.remote}.`);
          }
        } else if (command.kind === 'undo') {
          const transaction = await runtimeRef.current.transactions.undoLatest(
            runtimeRef.current.session?.id,
          );
          appendSystem(`Undid ${transaction.operation}: ${transaction.path}`);
        } else {
          appendSystem(`Unknown command: /${command.name}. Try /help.`, 'error');
        }
      } catch (error) {
        appendSystem(displayError(error), 'error');
      } finally {
        if (!modelTurnActive) {
          busyRef.current = false;
          setBusy(false);
          setStatus('Ready');
        }
      }
    },
    [
      appendSystem,
      exit,
      requestApproval,
      runPrompt,
      runtimeFactory,
      selectedSkills,
      setMode,
      swapRuntime,
      usage,
    ],
  );

  const submitDraft = useCallback((): void => {
    const value = draftRef.current.trim();
    if (value.length === 0) return;
    const command = parseTuiCommand(value);
    if (busyRef.current && !canRunWhileBusy(command)) return;
    historyRef.current = [...historyRef.current.filter((entry) => entry !== value), value].slice(
      -50,
    );
    historyIndexRef.current = -1;
    applyDraft('', 0);
    void runCommand(command);
  }, [applyDraft, runCommand]);

  // Applies the effort level chosen in the /effort picker and persists it to
  // the user config so the choice survives restarts instead of falling back
  // to the built-in default ('high') on the next launch.
  const applyEffort = useCallback(
    async (choice: ReasoningEffort): Promise<void> => {
      // runner 每轮读取同一配置对象，原地更新即可在下一轮生效。
      const active = runtimeRef.current;
      active.config.reasoning = choice;
      setRuntime({ ...active });
      try {
        const userConfigPath = getAppPaths().userConfigFile;
        const current = (await readJsonFileIfExists<ConfigFile>(userConfigPath)) ?? {};
        await writeConfigFile(userConfigPath, { ...current, reasoning: choice });
        appendSystem(`Reasoning effort set to ${choice} and saved as your default.`);
      } catch (error) {
        appendSystem(
          `Reasoning effort set to ${choice} for this session, but saving the default failed: ${displayError(error)}`,
          'error',
        );
      }
    },
    [appendSystem],
  );

  const contentWidth = Math.max(10, columns - 2);
  // Header, command deck, and footer have fixed heights in the normal view.
  // Reserving the transcript height explicitly lets the latest content anchor
  // to the command deck instead of relying on terminal flexbox behavior.
  const transcriptHeight = Math.max(5, rows - 9);
  const visibleHeight = Math.max(4, transcriptHeight - 1);

  useInput(
    (input, key) => {
      // Mouse reports (SGR sequences like `ESC[<0;x;yM`) reach the handler
      // with the escape prefix stripped; guard them before any key handling
      // so a scroll can never turn into an accidental cancel or typed text.
      if (input.startsWith('[<')) return;
      if (approval !== null) {
        if (key.ctrl && input.toLowerCase() === 'c') {
          resolveApproval({ approved: false, scope: 'once' });
          controllerRef.current?.abort();
          setStatus('Cancelling');
        } else if (input.toLowerCase() === 'y') {
          resolveApproval({ approved: true, scope: 'once' });
        } else if (input.toLowerCase() === 's') {
          resolveApproval({ approved: true, scope: 'session' });
        } else if (input.toLowerCase() === 'w') {
          resolveApproval({ approved: true, scope: 'workspace' });
        } else if (key.return || key.escape || input.toLowerCase() === 'n') {
          resolveApproval({ approved: false, scope: 'once' });
        }
        return;
      }
      if (effortPicker !== null) {
        if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) {
          setEffortPicker(null);
        } else if (key.return) {
          const choice = EFFORT_CHOICES[effortPicker];
          if (choice !== undefined) {
            void applyEffort(choice);
          }
          setEffortPicker(null);
        } else if (key.leftArrow) {
          setEffortPicker((selected) =>
            selected === null
              ? selected
              : (selected - 1 + EFFORT_CHOICES.length) % EFFORT_CHOICES.length,
          );
        } else if (key.rightArrow) {
          setEffortPicker((selected) =>
            selected === null ? selected : (selected + 1) % EFFORT_CHOICES.length,
          );
        }
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'c') {
        if (controllerRef.current !== undefined) {
          controllerRef.current.abort();
          setStatus('Cancelling');
        } else {
          exit();
        }
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'd') {
        exit();
        return;
      }
      // Ctrl+O: 切换思考过程（推理摘要）的显示/隐藏。
      if (key.ctrl && input.toLowerCase() === 'o') {
        setShowThinking((previous) => !previous);
        return;
      }
      // Shift+Tab: Ink's parseKeypress resolves the reverse-tab escape
      // sequence (\x1b[Z) into key.tab + key.shift and clears the raw input
      // (non-alphanumeric keys arrive as ''), so the sequence must be matched
      // on the Key object, not on `input`.
      if (key.tab && key.shift) {
        cycleAgentMode();
        return;
      }
      if (key.tab) {
        const completed = completeTuiCommand(draftRef.current);
        if (completed !== draftRef.current) {
          applyDraft(completed, completed.length);
        }
        return;
      }
      if (key.escape) {
        // ESC 只退出滚动视图或清空输入框，绝不中止正在运行的任务：
        // 运行期间按 ESC（例如想清空输入，或中文输入法关闭候选框时
        // 透传的 ESC）不应让长任务"自动中断"；取消任务请使用
        // Ctrl+C 或 /cancel。
        if (topLine >= 0) {
          setTopLine(-1);
        } else if (draftRef.current.length > 0) {
          applyDraft('', 0);
        }
        return;
      }
      if (key.pageUp) {
        setTopLine((previous) => {
          const max = Math.max(
            0,
            estimateEntriesLines(entries, contentWidth, showThinking) - visibleHeight,
          );
          const current = previous < 0 ? max : previous;
          return Math.max(0, current - Math.max(1, visibleHeight - 2));
        });
        return;
      }
      if (key.pageDown) {
        setTopLine((previous) => {
          if (previous <= 0) return -1;
          const next = previous - Math.max(1, visibleHeight - 2);
          return next <= 0 ? -1 : next;
        });
        return;
      }
      if (key.return) {
        submitDraft();
        return;
      }
      if (key.backspace) {
        const current = draftRef.current;
        const position = cursorRef.current;
        if (position > 0) {
          applyDraft(`${current.slice(0, position - 1)}${current.slice(position)}`, position - 1);
        }
        return;
      }
      if (key.delete) {
        const current = draftRef.current;
        const position = cursorRef.current;
        if (position < current.length) {
          applyDraft(`${current.slice(0, position)}${current.slice(position + 1)}`, position);
        }
        return;
      }
      if (key.leftArrow) {
        applyDraft(draftRef.current, Math.max(0, cursorRef.current - 1));
        return;
      }
      if (key.rightArrow) {
        applyDraft(draftRef.current, Math.min(draftRef.current.length, cursorRef.current + 1));
        return;
      }
      if (key.home || (key.ctrl && input.toLowerCase() === 'a')) {
        applyDraft(draftRef.current, 0);
        return;
      }
      if (key.end || (key.ctrl && input.toLowerCase() === 'e')) {
        applyDraft(draftRef.current, draftRef.current.length);
        return;
      }
      if (key.upArrow && draftRef.current.length === 0 && historyRef.current.length > 0) {
        const next = Math.min(historyRef.current.length - 1, historyIndexRef.current + 1);
        historyIndexRef.current = next;
        const value = historyRef.current[historyRef.current.length - 1 - next] ?? '';
        applyDraft(value, value.length);
        return;
      }
      if (key.downArrow && historyIndexRef.current >= 0) {
        const next = historyIndexRef.current - 1;
        historyIndexRef.current = next;
        const value =
          next < 0 ? '' : (historyRef.current[historyRef.current.length - 1 - next] ?? '');
        applyDraft(value, value.length);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        const inserted = input.replace(/[\r\n]+/gu, ' ');
        const current = draftRef.current;
        const position = cursorRef.current;
        applyDraft(
          `${current.slice(0, position)}${inserted}${current.slice(position)}`,
          position + inserted.length,
        );
      }
    },
    { isActive: true },
  );

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (deltaFlushTimerRef.current !== undefined) {
        clearInterval(deltaFlushTimerRef.current);
        deltaFlushTimerRef.current = undefined;
      }
    },
    [],
  );

  // Line estimates are recomputed on every render; memoising per entry keeps
  // long transcripts from re-wrapping thousands of characters on each update.
  const lineEstimatesRef = useRef(
    new Map<
      string,
      { entry: TranscriptEntry; width: number; gap: boolean; thinking: boolean; lines: number }
    >(),
  );
  const estimateEntryLinesCached = useCallback(
    (entry: TranscriptEntry, width: number, trailingGap: boolean, thinking: boolean): number => {
      const cached = lineEstimatesRef.current.get(entry.id);
      if (
        cached?.entry === entry &&
        cached.width === width &&
        cached.gap === trailingGap &&
        cached.thinking === thinking
      ) {
        return cached.lines;
      }
      const lines = estimateEntryLines(entry, width, trailingGap, thinking);
      lineEstimatesRef.current.set(entry.id, { entry, width, gap: trailingGap, thinking, lines });
      return lines;
    },
    [],
  );

  // The wheel listener mounts once, so it reads the latest scroll bounds from a ref.
  const scrollBoundsRef = useRef({ maximumTop: 0, visibleHeight: 0 });

  // Enable SGR mouse tracking so the wheel can scroll the transcript. Wheel
  // events arrive as `ESC[<64/65;...M` sequences on raw stdin; we intercept
  // them on our own listener before they are treated as typing.
  useEffect(() => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || !stdout.isTTY) return;
    try {
      stdout.write('\u001B[?1000h\u001B[?1006h');
    } catch {
      return;
    }
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const wheelUp = text.includes('\u001B[<64;');
      const wheelDown = text.includes('\u001B[<65;');
      if (wheelUp || wheelDown) {
        setTopLine((previous) => {
          const { maximumTop } = scrollBoundsRef.current;
          const current = previous < 0 ? maximumTop : previous;
          const next = current + (wheelUp ? -3 : 3);
          if (next >= maximumTop) return -1;
          return Math.max(0, next);
        });
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      try {
        stdout.write('\u001B[?1000l\u001B[?1006l');
      } catch {
        // The terminal may already be gone; nothing to restore.
      }
    };
  }, []);

  const totalLines = entries.reduce(
    (sum, entry, index) =>
      sum +
      estimateEntryLinesCached(entry, contentWidth, entryTrailingGap(entries, index), showThinking),
    0,
  );
  const maximumTop = Math.max(0, totalLines - visibleHeight);
  scrollBoundsRef.current = { maximumTop, visibleHeight };
  const clampedTop = topLine < 0 ? maximumTop : Math.min(topLine, maximumTop);
  const atBottom = topLine < 0;
  const sessionId = runtime.session?.id ?? 'pending';
  const sessionTitle = normaliseSessionTitle(runtime.session?.title) ?? 'NEW SESSION';
  const cursorDraft = `${draft.slice(0, cursor)}|${draft.slice(cursor)}`;
  const advice = cursor === draft.length ? tuiCommandAdvice(draft) : '';
  const approvalView = approval;
  const modeLabel = agentMode.toUpperCase();
  const modeColor = agentMode === 'plan' ? 'magenta' : agentMode === 'auto' ? 'green' : 'cyan';
  const activityLabel = busy
    ? language === 'zh-CN'
      ? '工作中'
      : 'WORKING'
    : language === 'zh-CN'
      ? '就绪'
      : 'READY';
  const activityColor = busy ? 'yellow' : 'green';
  const showWelcome = (runtime.session?.messages.length ?? 0) === 0 && entries.length === 0;

  return (
    <Box flexDirection="column" height="100%" width="100%" paddingX={1}>
      {showWelcome ? null : (
        <Box flexDirection="column" paddingX={1} backgroundColor="#1a1a1a">
          <Box justifyContent="space-between">
            <Text bold color="cyan">
              {'CodeFarmer'} <Text dimColor>{'· WORKSPACE SESSION'}</Text>
            </Text>
            <Text color={activityColor} bold>
              {`● ${activityLabel}`}
            </Text>
          </Box>
          <Box justifyContent="space-between">
            <Text dimColor wrap="truncate-middle">
              <Text color="gray">{'workspace  '}</Text>
              {runtime.workspace}
            </Text>
            <Text dimColor wrap="truncate-middle">
              <Text color="gray">{'session  '}</Text>
              {sessionTitle}
              <Text color="gray">{`  ${sessionId.slice(0, 8)}`}</Text>
            </Text>
          </Box>
        </Box>
      )}
      <Box
        flexDirection="column"
        justifyContent={showWelcome ? 'flex-start' : atBottom ? 'flex-end' : 'flex-start'}
        height={transcriptHeight}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        paddingTop={1}
      >
        {showWelcome ? (
          <WelcomePanel
            workspace={runtime.workspace}
            sessionTitle={sessionTitle}
            model={runtime.config.model}
            columns={contentWidth}
            language={language}
          />
        ) : entries.length === 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            <Text color="cyan" bold>
              {language === 'zh-CN' ? '开始任务' : 'Start a task'}
            </Text>
            <Text dimColor>
              {language === 'zh-CN'
                ? '描述要完成的修改，或输入 /help。'
                : 'Describe the change you want to make, or type /help.'}
            </Text>
          </Box>
        ) : (
          (() => {
            const rendered: React.ReactElement[] = [];
            let position = 0;
            let budget = visibleHeight;
            for (let index = 0; index < entries.length; index += 1) {
              const entry = entries[index];
              if (entry === undefined) continue;
              const trailingGap = entryTrailingGap(entries, index);
              const height = estimateEntryLinesCached(
                entry,
                contentWidth,
                trailingGap,
                showThinking,
              );
              const end = position + height;
              position = end;
              if (budget <= 0) break;
              if (end <= clampedTop) continue;
              const skip = Math.max(0, clampedTop - (end - height));
              rendered.push(
                <ClippedEntry
                  key={entry.id}
                  entry={entry}
                  skip={skip}
                  take={budget}
                  width={contentWidth}
                  trailingGap={trailingGap}
                  showThinking={showThinking}
                />,
              );
              budget -= Math.min(height - skip, budget);
            }
            return rendered;
          })()
        )}
        {busy ? <Spinner label={status} language={language} /> : null}
      </Box>
      {approvalView === null ? null : (
        <ApprovalModal approval={approvalView} columns={columns} rows={rows} />
      )}
      {effortPicker === null ? null : (
        <EffortPicker
          current={runtime.config.reasoning}
          selected={effortPicker}
          language={language}
        />
      )}
      <Box justifyContent="flex-end" paddingX={1}>
        <Text dimColor>
          {'● '}
          {runtime.config.reasoning}
          {' · /effort'}
        </Text>
      </Box>
      <Text color={busy ? 'yellow' : 'gray'}>{'─'.repeat(contentWidth)}</Text>
      <Box flexDirection="column" paddingX={1}>
        <Text color={modeColor} bold>
          {'> '}
          <Text dimColor>
            {busy
              ? language === 'zh-CN'
                ? `${String(runtime.orchestrator?.snapshot().queuedTurns.length ?? 0)} 条排队 · 回车添加`
                : `${String(runtime.orchestrator?.snapshot().queuedTurns.length ?? 0)} queued · Enter to add`
              : language === 'zh-CN'
                ? '回车执行'
                : 'Enter to run'}
          </Text>
        </Text>
        <Box>
          {draft.length === 0 ? (
            <Text dimColor wrap="truncate-end">
              {busy
                ? language === 'zh-CN'
                  ? '输入下一条指令…'
                  : 'Type your next instruction…'
                : agentMode === 'plan'
                  ? language === 'zh-CN'
                    ? '计划模式仅进行只读探索'
                    : 'Plan mode is read-only'
                  : agentMode === 'auto'
                    ? language === 'zh-CN'
                      ? '自动模式将先制定计划，再执行并验证'
                      : 'Auto mode plans, executes, and validates'
                    : language === 'zh-CN'
                      ? '描述要完成的任务，或输入 /help'
                      : 'Describe the task, or type /help'}
            </Text>
          ) : (
            <Text wrap="truncate-end">
              {cursorDraft}
              {advice.length === 0 ? null : <Text dimColor>{advice}</Text>}
            </Text>
          )}
        </Box>
      </Box>
      <Text color={busy ? 'yellow' : 'gray'}>{'─'.repeat(contentWidth)}</Text>
      <Box justifyContent="space-between">
        <Text dimColor wrap="truncate-end">
          {agentMode === 'auto' ? 'auto approval' : `${runtime.config.approval} approval`}
          {' · Shift+Tab mode · ? /help'}
          {showThinking ? ' · thinking' : ''}
          {atBottom ? '' : ` · ↑ ${String(clampedTop)}/${String(maximumTop)} (PgDn latest)`}
        </Text>
        <Text>
          <Text dimColor>{`${status} · `}</Text>
          <Text color={modeColor} bold>
            {modeLabel}
          </Text>
          <Text dimColor>{` · ${String(usage.totalTokens)} tokens`}</Text>
        </Text>
      </Box>
    </Box>
  );
}
