import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts';
import chalk from 'chalk';
import { execa } from 'execa';

import type { AgentRunResult } from '../core/runtime-types.js';
import { compactSession, sessionContextChars } from '../core/session-compact.js';
import { discoverSkills } from '../core/skills.js';
import { computeWorkspaceStats, type WorkspaceStats } from '../core/stats.js';
import {
  getCredentialsPath,
  resolveProviderApiKey,
  saveProviderApiKey,
} from '../infra/credentials.js';
import {
  ApprovalError,
  AuthenticationError,
  ConfigError,
  ConflictError,
  toAppError,
} from '../infra/errors.js';
import {
  DEFAULT_CONFIG,
  loadConfigDetails,
  providerDefaults,
  writeConfigFile,
  type ConfigFile,
} from '../infra/config.js';
import { canonicalWorkspace, getAppPaths } from '../infra/paths.js';
import { fileExists, readJsonFileIfExists } from '../infra/persistence.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { isProviderId, providerPreset } from '../providers/catalog.js';
import { detectGitAvailability } from '../tools/git-tools.js';
import { normaliseLanguage } from '../types.js';
import type { AgentProvider, ProviderId, SessionRecord, SessionStatus } from '../types.js';
import { createAgentRuntime, createBaseRuntime, type GlobalOptions } from './runtime.js';
import { renderSessionExport, type SessionExportFormat } from './session-export.js';
import { colorizeDiff, createEventRenderer, printJson, printResultMessage } from './ui.js';

export interface RunOptions {
  json?: boolean;
  history?: boolean;
  session?: string;
  plan?: boolean;
  skills?: string[];
}

export interface PushOptions {
  yes?: boolean;
  setUpstream?: boolean;
  remote?: string;
  branch?: string;
}

export interface StatsOptions {
  json?: boolean;
}

function cliResult(result: AgentRunResult): Record<string, unknown> {
  return {
    sessionId: result.sessionId,
    status: result.status,
    message: result.message,
    ...(result.responseId === undefined ? {} : { responseId: result.responseId }),
    toolCalls: result.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      success: call.result.success,
      ...(call.result.error === undefined ? {} : { error: call.result.error }),
      ...(call.result.truncated === undefined ? {} : { truncated: call.result.truncated }),
      ...(call.result.durationMs === undefined ? {} : { durationMs: call.result.durationMs }),
    })),
    usage: result.usage,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function installInterruptHandler(controller: AbortController): () => void {
  let count = 0;
  const handler = (): void => {
    count += 1;
    if (count === 1) {
      controller.abort();
      process.stderr.write('\n正在取消当前操作；再次按 Ctrl+C 将立即退出。\n');
      return;
    }
    process.exitCode = 130;
    process.exit();
  };
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

export async function runAction(
  promptParts: string[],
  globalOptions: GlobalOptions,
  runOptions: RunOptions,
): Promise<AgentRunResult> {
  const prompt = promptParts.join(' ').trim();
  if (prompt.length === 0) throw new ConfigError('run 命令需要任务描述');
  const history = runOptions.history ?? true;
  const json = runOptions.json ?? false;
  try {
    const runtime = await createAgentRuntime(globalOptions, {
      ...(runOptions.session === undefined ? {} : { sessionId: runOptions.session }),
      history,
    });
    const controller = new AbortController();
    const cleanup = installInterruptHandler(controller);
    try {
      const result = await runtime.runner.run(prompt, {
        ...(runtime.session === undefined ? {} : { session: runtime.session }),
        history,
        signal: controller.signal,
        ...(runOptions.plan === true ? { plan: true } : {}),
        ...(runOptions.skills === undefined ? {} : { skills: runOptions.skills }),
        onEvent: createEventRenderer({ json, stream: runtime.config.stream }),
      });
      if (json) printJson(cliResult(result));
      else printResultMessage(result.message, runtime.config.stream);
      if (result.status === 'cancelled') process.exitCode = 130;
      else if (result.toolCalls.some((call) => call.result.error?.code === 'APPROVAL_DENIED')) {
        process.exitCode = 3;
      }
      return result;
    } finally {
      cleanup();
    }
  } catch (error) {
    if (!json) throw error;
    const appError = toAppError(error);
    const result: AgentRunResult = {
      sessionId: runOptions.session ?? '',
      status: 'failed',
      message: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      error: { code: appError.code, message: appError.message },
    };
    printJson(cliResult(result));
    process.exitCode = appError.exitCode;
    return result;
  }
}

export async function skillsListAction(globalOptions: GlobalOptions): Promise<void> {
  const workspace = await canonicalWorkspace(globalOptions.cwd ?? process.cwd());
  const catalog = await discoverSkills(workspace);
  if (catalog.skills.length === 0) {
    process.stdout.write('No skills discovered.\n');
    return;
  }
  process.stdout.write(
    `${catalog.skills
      .map((skill) => `${skill.ref}\t${skill.scope}\t${skill.description}\t${skill.skillFile}`)
      .join('\n')}\n`,
  );
  catalog.warnings.forEach((warning) => process.stderr.write(`Warning: ${warning}\n`));
}

export async function skillsShowAction(
  globalOptions: GlobalOptions,
  ref: string,
  resourcePath?: string,
): Promise<void> {
  const workspace = await canonicalWorkspace(globalOptions.cwd ?? process.cwd());
  const catalog = await discoverSkills(workspace);
  if (resourcePath === undefined) {
    const skill = await catalog.read(ref);
    process.stdout.write(skill.instructions);
    if (!skill.instructions.endsWith('\n')) process.stdout.write('\n');
    return;
  }
  const resource = await catalog.readResource(ref, resourcePath);
  process.stdout.write(resource.content);
  if (!resource.content.endsWith('\n')) process.stdout.write('\n');
}

function printSession(session: SessionRecord): void {
  const title = (session.title ?? '(未命名)').replace(/[\t\r\n]/gu, ' ');
  process.stdout.write(
    `${session.id}\t${session.status}\t${title}\t${session.model}\t${session.updatedAt}\t${String(session.messages.length)} messages\n`,
  );
}

async function showWorkspaceStatus(globalOptions: GlobalOptions): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  const recent = (await runtime.sessions.list()).slice(0, 5);
  let git = '非 Git 工作区';
  if (!(await detectGitAvailability()).available) {
    git = '未安装 Git（可选，Git 状态与差异功能不可用）';
  } else {
    try {
      const result = await execa(
        'git',
        ['-c', 'core.fsmonitor=false', 'status', '--short', '--branch', '--', '.'],
        {
          cwd: runtime.workspace,
          reject: false,
          env: { GIT_OPTIONAL_LOCKS: '0' },
        },
      );
      git = result.exitCode === 0 ? result.stdout || '工作区干净' : '非 Git 工作区';
    } catch {
      git = 'Git 不可用';
    }
  }
  process.stdout.write(`${chalk.bold('工作区')} ${runtime.workspace}\n`);
  process.stdout.write(
    `${chalk.bold('Provider')} ${providerPreset(runtime.config.provider).label}\n`,
  );
  process.stdout.write(
    `${chalk.bold('模型')} ${runtime.config.model} (${runtime.config.reasoning}, ${runtime.config.verbosity})\n`,
  );
  process.stdout.write(`${chalk.bold('Base URL')} ${runtime.config.baseURL}\n`);
  process.stdout.write(`${chalk.bold('审批')} ${runtime.config.approval}\n`);
  process.stdout.write(`${chalk.bold('Git')}\n${git}\n`);
  process.stdout.write(`${chalk.bold('最近会话')}\n`);
  if (recent.length === 0) process.stdout.write('暂无会话\n');
  else recent.forEach(printSession);
}

export async function chatAction(globalOptions: GlobalOptions, sessionId?: string): Promise<void> {
  let runtime = await createAgentRuntime(globalOptions, {
    ...(sessionId === undefined ? {} : { sessionId }),
    history: true,
  });
  process.stdout.write(chalk.bold(`CodeFarmer 会话 ${runtime.session?.id ?? ''}\n`));
  process.stdout.write(chalk.dim('输入 /help 查看会话命令。\n'));

  for (;;) {
    const answer = await text({ message: '任务' });
    if (isCancel(answer)) break;
    const prompt = answer.trim();
    if (prompt.length === 0) continue;
    if (prompt === '/exit') break;
    if (prompt === '/help') {
      process.stdout.write('/help /status /diff /undo /new /exit\n');
      continue;
    }
    if (prompt === '/status') {
      await showWorkspaceStatus(globalOptions);
      continue;
    }
    if (prompt === '/diff') {
      if (!(await detectGitAvailability()).available) {
        process.stdout.write('Git 未安装或不在 PATH，无法显示差异（Git 为可选依赖）\n');
        continue;
      }
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
          cwd: runtime.workspace,
          reject: false,
          env: { GIT_EXTERNAL_DIFF: '', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
        },
      );
      if (result.exitCode !== 0) {
        process.stdout.write(`${result.stderr.trim() || '无法显示 Git 差异'}\n`);
      } else {
        process.stdout.write(`${colorizeDiff(result.stdout || '(无差异)')}\n`);
      }
      continue;
    }
    if (prompt === '/undo') {
      const transaction = await runtime.transactions.undoLatest(runtime.session?.id);
      process.stdout.write(`已撤销 ${transaction.path}\n`);
      continue;
    }
    if (prompt === '/new') {
      runtime = await createAgentRuntime(globalOptions, { history: true });
      process.stdout.write(`新会话 ${runtime.session?.id ?? ''}\n`);
      continue;
    }

    const controller = new AbortController();
    const cleanup = installInterruptHandler(controller);
    try {
      const result = await runtime.runner.run(prompt, {
        ...(runtime.session === undefined ? {} : { session: runtime.session }),
        history: true,
        signal: controller.signal,
        onEvent: createEventRenderer({ json: false, stream: runtime.config.stream }),
      });
      printResultMessage(result.message, runtime.config.stream);
    } finally {
      cleanup();
    }
  }
}

const SETUP_SCHEMA_URL = 'https://unpkg.com/codefarmer@0.1.1/schemas/codefarmer.config.schema.json';

export async function initAction(globalOptions: GlobalOptions, force = false): Promise<void> {
  const workspace = await canonicalWorkspace(globalOptions.cwd ?? process.cwd());
  const projectConfigPath = path.join(workspace, 'codefarmer.config.json');
  if ((await fileExists(projectConfigPath)) && !force) {
    throw new ConflictError(`配置已存在: ${projectConfigPath}；使用 --force 覆盖`);
  }
  const initial: ConfigFile = {
    $schema: SETUP_SCHEMA_URL,
    provider: DEFAULT_CONFIG.provider,
    model: DEFAULT_CONFIG.model,
    baseURL: DEFAULT_CONFIG.baseURL,
    reasoning: DEFAULT_CONFIG.reasoning,
    verbosity: DEFAULT_CONFIG.verbosity,
    reasoningSummary: DEFAULT_CONFIG.reasoningSummary,
    approval: DEFAULT_CONFIG.approval,
  };
  await writeConfigFile(projectConfigPath, initial);
  process.stdout.write(`已创建 ${projectConfigPath}\n`);
}

function isValidBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function abortSetup(): void {
  cancel('已取消 setup，未写入任何配置。');
  process.exitCode = 130;
}

function createProvider(
  provider: ProviderId,
  baseURL: string,
  model: string,
  apiKey: string,
): AgentProvider {
  return provider === 'openai'
    ? new OpenAIProvider({ apiKey, baseURL, connectionModel: model })
    : new OpenAICompatibleProvider({ provider, apiKey, baseURL });
}

async function testConnection(
  provider: ProviderId,
  baseURL: string,
  model: string,
  apiKey?: string,
): Promise<void> {
  const progress = spinner();
  progress.start(`正在测试 ${providerPreset(provider).label} 连接`);
  try {
    if (apiKey === undefined) throw new Error('缺少 API Key');
    await createProvider(provider, baseURL, model, apiKey).checkConnection?.();
    progress.stop('连接测试通过');
  } catch (error) {
    progress.stop(`连接测试失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function setupAction(globalOptions: GlobalOptions, force = false): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ConfigError('setup 需要交互式终端；非交互环境请使用 init 与 config set 命令');
  }
  const workspace = await canonicalWorkspace(globalOptions.cwd ?? process.cwd());
  const details = await loadConfigDetails({ cwd: workspace });
  const defaults = details.config;
  const projectConfigPath = details.projectConfigPath;

  intro('CodeFarmer Setup');

  if ((await fileExists(projectConfigPath)) && !force) {
    const overwrite = await confirm({
      message: `检测到已有项目配置 ${projectConfigPath}，是否覆盖？`,
      initialValue: false,
    });
    if (isCancel(overwrite)) return abortSetup();
    if (!overwrite) {
      outro('已保留现有配置，未做任何修改。');
      return;
    }
  }

  const selectedProvider = await select({
    message: 'AI Provider',
    options: [
      { value: 'openai', label: 'OpenAI' },
      { value: 'gemini', label: 'Google Gemini' },
      { value: 'grok', label: 'xAI Grok' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'kimi', label: 'Kimi' },
    ],
    initialValue: defaults.provider,
  });
  if (isCancel(selectedProvider)) return abortSetup();
  const provider = selectedProvider;
  const preset = providerPreset(provider);
  const providerConfig =
    provider === defaults.provider
      ? defaults
      : { ...defaults, model: preset.defaultModel, baseURL: preset.defaultBaseURL };

  const model = await text({
    message: `${preset.label} 模型`,
    initialValue: providerConfig.model,
    validate: (value) => (value.trim().length === 0 ? '模型不能为空' : undefined),
  });
  if (isCancel(model)) return abortSetup();

  const baseURL = await text({
    message: `${preset.label} API Base URL`,
    initialValue: providerConfig.baseURL,
    validate: (value) =>
      isValidBaseUrl(value) ? undefined : '需要合法的 HTTP(S) URL，且不能包含凭据',
  });
  if (isCancel(baseURL)) return abortSetup();

  const reasoning = await select({
    message: '推理强度',
    options: [
      { value: 'auto', label: 'auto', hint: '由模型自行决定思考深度' },
      { value: 'none', label: 'none', hint: '关闭推理' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium', hint: '默认' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
    ],
    initialValue: defaults.reasoning,
  });
  if (isCancel(reasoning)) return abortSetup();

  const verbosity = await select({
    message: '文本详细度',
    options: [
      { value: 'low', label: 'low', hint: '简短，节省 token（默认）' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
    ],
    initialValue: defaults.verbosity,
  });
  if (isCancel(verbosity)) return abortSetup();

  const reasoningSummary = await select({
    message: '推理摘要',
    options: [
      { value: 'none', label: 'none', hint: '不生成可见摘要，节省 token（默认）' },
      { value: 'auto', label: 'auto' },
      { value: 'concise', label: 'concise' },
      { value: 'detailed', label: 'detailed' },
    ],
    initialValue: defaults.reasoningSummary,
  });
  if (isCancel(reasoningSummary)) return abortSetup();

  const approval = await select({
    message: '审批策略',
    options: [
      { value: 'ask', label: 'ask', hint: '写操作前询问（默认）' },
      { value: 'auto', label: 'auto', hint: '自动批准' },
      { value: 'read-only', label: 'read-only', hint: '仅允许只读操作' },
    ],
    initialValue: defaults.approval,
  });
  if (isCancel(approval)) return abortSetup();

  const normalizedBaseUrl = baseURL.replace(/\/+$/u, '');
  let apiKey = await resolveProviderApiKey(provider);
  const environmentKey = preset.environmentVariables.find((name) => process.env[name]?.trim());
  if (environmentKey !== undefined) {
    process.stdout.write(`${chalk.green('✓')} 使用环境变量中的 ${environmentKey}。\n`);
  } else if (apiKey !== undefined) {
    process.stdout.write(`${chalk.green('✓')} 使用已保存的本地凭据 ${getCredentialsPath()}。\n`);
    const replaceKey = await confirm({
      message: '是否更换已保存的 API Key？',
      initialValue: false,
    });
    if (isCancel(replaceKey)) return abortSetup();
    if (replaceKey) apiKey = undefined;
  }
  if (apiKey === undefined) {
    const input = await password({
      message: `${preset.label} API Key（不会写入项目配置，仅保存到本地凭据文件；留空跳过）`,
      validate: () => undefined,
    });
    if (isCancel(input)) return abortSetup();
    const trimmed = input.trim();
    if (trimmed.length > 0) {
      apiKey = trimmed;
      const savedPath = await saveProviderApiKey(provider, trimmed);
      process.stdout.write(`${chalk.green('✓')} API Key 已保存到 ${savedPath}\n`);
    } else {
      process.stdout.write(
        `${chalk.yellow('⚠')} 未提供 API Key；运行任务前请设置 ${preset.environmentVariables[0] ?? '对应的 API Key'} 环境变量或重新运行 setup。\n`,
      );
    }
  }
  if (apiKey !== undefined) {
    const shouldTest = await confirm({
      message: '是否现在测试连接？',
      initialValue: true,
    });
    if (isCancel(shouldTest)) return abortSetup();
    if (shouldTest) await testConnection(provider, normalizedBaseUrl, model, apiKey);
  }

  const config: ConfigFile = {
    $schema: SETUP_SCHEMA_URL,
    provider,
    model,
    baseURL: normalizedBaseUrl,
    reasoning,
    verbosity,
    reasoningSummary,
    approval,
  };
  await writeConfigFile(projectConfigPath, config);
  outro(`已写入 ${projectConfigPath}；下一步可运行 codefarmer doctor 或直接启动 codefarmer`);
}

export async function statusAction(globalOptions: GlobalOptions): Promise<void> {
  await showWorkspaceStatus(globalOptions);
}

export async function undoAction(globalOptions: GlobalOptions, sessionId?: string): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  const transaction = await runtime.transactions.undoLatest(sessionId);
  process.stdout.write(`已撤销 ${transaction.operation}: ${transaction.path}\n`);
}

// Conservative Git environment for the user-invoked push command: no external
// diff drivers, no pager, and no optional locks (mirrors the agent Git tools).
const PUSH_GIT_ENV = {
  GIT_EXTERNAL_DIFF: '',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};

interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGitForPush(args: string[], cwd: string): Promise<GitRunResult> {
  const result = await execa('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd,
    reject: false,
    env: PUSH_GIT_ENV,
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function validateGitArgument(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith('-')) {
    throw new ConfigError(`${label}不能为空或以 - 开头`);
  }
  return trimmed;
}

async function pushCurrentBranch(workspace: string): Promise<string> {
  const result = await runGitForPush(['rev-parse', '--abbrev-ref', 'HEAD'], workspace);
  if (result.exitCode !== 0) {
    if (/not a git repository/iu.test(result.stderr)) {
      throw new ConfigError(`${workspace} 不是 Git 仓库；push 命令需要在 Git 仓库中运行`);
    }
    throw new ConfigError(result.stderr.trim() || '无法读取当前 Git 分支');
  }
  return result.stdout.trim();
}

export async function pushAction(
  globalOptions: GlobalOptions,
  options: PushOptions = {},
): Promise<void> {
  const workspace = await canonicalWorkspace(globalOptions.cwd ?? process.cwd());
  const availability = await detectGitAvailability();
  if (!availability.available) {
    throw new ConfigError('push 命令需要 Git；请先安装 Git 并确保 git 在 PATH 中');
  }

  const branch =
    options.branch === undefined || options.branch.trim().length === 0
      ? await pushCurrentBranch(workspace)
      : validateGitArgument(options.branch, '分支名');
  if (branch === 'HEAD') {
    throw new ConfigError('当前处于分离 HEAD 状态，无法推送；请先切换到具体分支');
  }
  const requestedRemote =
    options.remote === undefined ? undefined : validateGitArgument(options.remote, '远程名');

  const upstreamResult = await runGitForPush(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`],
    workspace,
  );
  const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : undefined;
  let remote = requestedRemote;
  if (remote === undefined && upstream !== undefined) {
    const slash = upstream.indexOf('/');
    remote = slash > 0 ? upstream.slice(0, slash) : upstream;
  }
  remote ??= options.setUpstream ? 'origin' : undefined;
  if (remote === undefined) {
    throw new ConfigError(
      `分支 ${branch} 没有上游分支。首次推送请使用: codefarmer push --set-upstream --remote origin`,
    );
  }

  // Summarize which commits would be pushed before asking for confirmation.
  const ahead: string[] = [];
  if (upstream !== undefined) {
    const logResult = await runGitForPush(['log', '--oneline', `${branch}@{u}..HEAD`], workspace);
    if (logResult.exitCode === 0) {
      ahead.push(...logResult.stdout.split('\n').filter((line) => line.length > 0));
    }
  }

  process.stdout.write(`${chalk.bold('推送')} ${branch} → ${remote}\n`);
  if (upstream !== undefined) process.stdout.write(`${chalk.bold('上游')} ${upstream}\n`);
  if (ahead.length > 0) {
    process.stdout.write(`${chalk.bold('将推送')} ${String(ahead.length)} 个提交:\n`);
    ahead.forEach((line) => process.stdout.write(`  ${line}\n`));
  } else if (upstream !== undefined) {
    process.stdout.write('没有新的提交可推送。\n');
  }

  // A push with no local commits ahead can only be a no-op, so it needs no
  // confirmation; everything else requires an explicit yes (or `--yes`).
  const needsConfirmation =
    options.setUpstream === true || upstream === undefined || ahead.length > 0;
  if (needsConfirmation && options.yes !== true) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new ApprovalError('非交互环境推送需要显式确认；请添加 --yes 参数');
    }
    const answer = await confirm({
      message: `确认将 ${branch} 推送到 ${remote}？`,
      initialValue: false,
    });
    if (isCancel(answer) || !answer) {
      cancel('已取消推送。');
      process.exitCode = 130;
      return;
    }
  }

  const pushArgs = ['push'];
  if (options.setUpstream === true) pushArgs.push('-u');
  pushArgs.push(remote, branch);
  const result = await runGitForPush(pushArgs, workspace);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git push 失败（退出码 ${String(result.exitCode)}）`);
  }
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stdout.write(result.stderr);
  process.stdout.write(`已推送 ${branch} 到 ${remote}\n`);
}

export async function sessionsListAction(globalOptions: GlobalOptions): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  const sessions = await runtime.sessions.list();
  if (sessions.length === 0) process.stdout.write('暂无会话\n');
  else sessions.forEach(printSession);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

function printWorkspaceStats(stats: WorkspaceStats): void {
  const statusLabels: Record<SessionStatus, string> = {
    active: '进行中',
    completed: '已完成',
    cancelled: '已取消',
    failed: '失败',
  };
  const statusSummary = (Object.entries(stats.statusCounts) as [SessionStatus, number][])
    .map(([status, count]) => `${statusLabels[status]} ${String(count)}`)
    .join(' / ');
  process.stdout.write(
    `${chalk.bold('会话')} ${String(stats.totalSessions)} 个（${statusSummary}）\n`,
  );
  process.stdout.write(
    `${chalk.bold('Token 累计')} 输入 ${formatCount(stats.usage.inputTokens)} / ` +
      `输出 ${formatCount(stats.usage.outputTokens)} / 合计 ${formatCount(stats.usage.totalTokens)}` +
      `（推理 ${formatCount(stats.usage.reasoningTokens)}，缓存输入 ${formatCount(stats.usage.cachedInputTokens)}）\n`,
  );
  process.stdout.write(
    `${chalk.bold('消息 / 工具调用')} ${formatCount(stats.totalMessages)} / ${formatCount(stats.totalToolCalls)}\n`,
  );
  process.stdout.write(
    `${chalk.bold('近 7 天 / 30 天会话')} ${formatCount(stats.recent.last7Days)} / ${formatCount(stats.recent.last30Days)}\n`,
  );
  process.stdout.write(`${chalk.bold('按模型')}（仅统计记录用量的会话，估算费用按公开列表价）\n`);
  for (const stat of stats.byModel) {
    const cost = stat.priceMatched ? formatUsd(stat.estimatedCostUsd) : '未知';
    process.stdout.write(
      `  ${stat.model}\t${stat.provider}\t${String(stat.sessions)} 会话\t` +
        `${formatCount(stat.usage.totalTokens)} tokens\t${cost}\n`,
    );
  }
  if (stats.costUnknownModels.length > 0) {
    process.stdout.write(
      `${chalk.yellow('未匹配价格表的模型（费用未知，未计入合计）')} ${stats.costUnknownModels.join(', ')}\n`,
    );
  }
  process.stdout.write(
    `${chalk.bold('估算费用')} ${formatUsd(stats.estimatedCostUsd)}（仅计已匹配模型；非账单，请以 Provider 账单为准）\n`,
  );
}

export async function statsAction(globalOptions: GlobalOptions, json = false): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  const sessions = await runtime.sessions.list();
  const stats = computeWorkspaceStats(sessions);
  if (json) {
    printJson(stats);
    return;
  }
  if (stats.totalSessions === 0) {
    process.stdout.write(
      '暂无会话；完成第一次 codefarmer run 后这里会显示 Token 用量与费用统计。\n',
    );
    return;
  }
  printWorkspaceStats(stats);
}

export async function sessionsShowAction(globalOptions: GlobalOptions, id: string): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  printJson(await runtime.sessions.get(id));
}

export async function sessionsDeleteAction(
  globalOptions: GlobalOptions,
  id: string,
): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  await runtime.sessions.delete(id);
  process.stdout.write(`已删除本地会话 ${id}\n`);
}

export async function sessionsRenameAction(
  globalOptions: GlobalOptions,
  id: string,
  title: string,
): Promise<void> {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new ConfigError('会话标题不能为空');
  const runtime = await createBaseRuntime(globalOptions);
  await runtime.sessions.rename(id, trimmed);
  process.stdout.write(`已重命名会话 ${id} 为 "${trimmed}"\n`);
}

export async function sessionsCompactAction(
  globalOptions: GlobalOptions,
  id: string,
): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  const session = await runtime.sessions.get(id);
  const apiKey = await resolveProviderApiKey(runtime.config.provider);
  if (!apiKey) {
    throw new AuthenticationError(`缺少 ${runtime.config.provider} 的 API Key`);
  }
  const provider = createProvider(
    runtime.config.provider,
    session.baseURL ?? runtime.config.baseURL,
    runtime.config.model,
    apiKey,
  );
  const beforeChars = sessionContextChars(session);
  const result = await compactSession({
    session,
    provider,
    config: runtime.config,
  });
  await runtime.sessions.save(session);
  const afterChars = sessionContextChars(session);
  process.stdout.write(
    `已压缩会话 ${id}：${String(result.compressedMessageCount)} 条早期消息折叠为 ` +
      `摘要（${String(result.summary.length)} 字符），保留最近 ${String(result.keptMessageCount)} 条；` +
      `上下文由约 ${String(beforeChars)} 字符降至约 ${String(afterChars)} 字符。\n`,
  );
}

export async function sessionsExportAction(
  globalOptions: GlobalOptions,
  id: string,
  format: SessionExportFormat,
  outputPath: string | undefined,
): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  const session = await runtime.sessions.get(id);
  const rendered = renderSessionExport(session, format);
  if (outputPath === undefined) {
    process.stdout.write(rendered);
    return;
  }
  await writeFile(outputPath, rendered, 'utf8');
  process.stdout.write(`已导出会话 ${id} 到 ${outputPath}\n`);
}

export async function configListAction(globalOptions: GlobalOptions): Promise<void> {
  const providerConfig =
    globalOptions.provider === undefined ? {} : providerDefaults(globalOptions.provider);
  const details = await loadConfigDetails({
    cwd: globalOptions.cwd ?? process.cwd(),
    cli: {
      ...(globalOptions.provider === undefined ? {} : { provider: globalOptions.provider }),
      ...(globalOptions.model === undefined ? providerConfig : { model: globalOptions.model }),
      ...(globalOptions.baseURL === undefined
        ? providerConfig
        : { baseURL: globalOptions.baseURL }),
      ...(globalOptions.reasoning === undefined ? {} : { reasoning: globalOptions.reasoning }),
      ...(globalOptions.verbosity === undefined ? {} : { verbosity: globalOptions.verbosity }),
      ...(globalOptions.reasoningSummary === undefined
        ? {}
        : { reasoningSummary: globalOptions.reasoningSummary }),
      ...(globalOptions.approval === undefined ? {} : { approval: globalOptions.approval }),
      ...(globalOptions.language === undefined ? {} : { language: globalOptions.language }),
    },
  });
  printJson(details.config);
}

/** Show or persist the preferred interface/agent language. */
export async function languageAction(
  globalOptions: GlobalOptions,
  value: string | undefined,
  project = false,
): Promise<void> {
  const details = await loadConfigDetails({ cwd: globalOptions.cwd ?? process.cwd() });
  if (value === undefined) {
    process.stdout.write(`${details.config.language}\n`);
    return;
  }
  const language = normaliseLanguage(value);
  if (language === undefined) {
    throw new ConfigError('语言必须是 en 或 zh-CN（也支持 zh、中文、English）。');
  }
  const target = project ? details.projectConfigPath : details.userConfigPath;
  const current = (await readJsonFileIfExists<ConfigFile>(target)) ?? {};
  await writeConfigFile(target, { ...current, language });
  process.stdout.write(`已将语言设置为 ${language}（${target}）\n`);
}

export async function configGetAction(globalOptions: GlobalOptions, key: string): Promise<void> {
  const details = await loadConfigDetails({ cwd: globalOptions.cwd ?? process.cwd() });
  if (!(key in details.config)) throw new ConfigError(`未知配置项: ${key}`);
  printJson(details.config[key as keyof typeof details.config]);
}

function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function configSetAction(
  globalOptions: GlobalOptions,
  key: string,
  raw: string,
  project: boolean,
): Promise<void> {
  if (/api.?key|token|secret|password/iu.test(key)) {
    throw new ConfigError(
      '凭据不能写入配置；请设置对应 Provider 的 API Key 环境变量，或运行 codefarmer setup 保存到本地凭据',
    );
  }
  const details = await loadConfigDetails({ cwd: globalOptions.cwd ?? process.cwd() });
  const target = project ? details.projectConfigPath : details.userConfigPath;
  const current = (await readJsonFileIfExists<ConfigFile>(target)) ?? {};
  const value = parseConfigValue(raw);
  if (key === 'provider') {
    if (typeof value !== 'string' || !isProviderId(value)) {
      throw new ConfigError('provider 必须是 openai、gemini、grok、deepseek 或 kimi。');
    }
    const candidate = { ...current, provider: value, ...providerDefaults(value) };
    await writeConfigFile(target, candidate);
    process.stdout.write(`已更新 ${target}\n`);
    return;
  }
  if (key === 'language') {
    if (typeof value !== 'string') {
      throw new ConfigError('language 必须是 en 或 zh-CN（也支持 zh、中文、English）。');
    }
    const language = normaliseLanguage(value);
    if (language === undefined) {
      throw new ConfigError('language 必须是 en 或 zh-CN（也支持 zh、中文、English）。');
    }
    await writeConfigFile(target, { ...current, language });
    process.stdout.write(`已更新 ${target}\n`);
    return;
  }
  const candidate = { ...current, [key]: value };
  await writeConfigFile(target, candidate);
  process.stdout.write(`已更新 ${target}\n`);
}

export async function configPathAction(globalOptions: GlobalOptions): Promise<void> {
  const details = await loadConfigDetails({ cwd: globalOptions.cwd ?? process.cwd() });
  process.stdout.write(`user\t${details.userConfigPath}\nproject\t${details.projectConfigPath}\n`);
}

export async function doctorAction(globalOptions: GlobalOptions): Promise<void> {
  const runtime = await createBaseRuntime(globalOptions);
  const workspace = runtime.workspace;
  const checks: { name: string; ok: boolean; detail: string; warn?: boolean }[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js', ok: major >= 22, detail: process.version });
  try {
    await access(workspace, constants.R_OK | constants.W_OK);
    checks.push({ name: 'Workspace', ok: true, detail: workspace });
  } catch (error) {
    checks.push({
      name: 'Workspace',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const gitAvailability = await detectGitAvailability();
  if (gitAvailability.available) {
    checks.push({ name: 'Git', ok: true, detail: `${gitAvailability.version ?? ''}（可选）` });
  } else {
    checks.push({
      name: 'Git',
      ok: true,
      warn: true,
      detail: '未安装或不在 PATH（可选，仅 Git 状态与差异功能不可用）',
    });
  }
  const preset = providerPreset(runtime.config.provider);
  const resolvedKey = await resolveProviderApiKey(runtime.config.provider);
  const keyEnvironment = preset.environmentVariables.find((name) => process.env[name]?.trim());
  const keySource = keyEnvironment === undefined ? `本地凭据 ${getCredentialsPath()}` : '环境变量';
  checks.push({
    name: `${preset.label} API Key`,
    ok: resolvedKey !== undefined,
    detail: resolvedKey === undefined ? '未设置' : `已设置（${keySource}）`,
  });
  checks.push({ name: 'Base URL', ok: true, detail: runtime.config.baseURL });
  if (resolvedKey !== undefined) {
    try {
      await createProvider(
        runtime.config.provider,
        runtime.config.baseURL,
        runtime.config.model,
        resolvedKey,
      ).checkConnection?.();
      checks.push({ name: preset.label, ok: true, detail: '连接成功' });
    } catch (error) {
      checks.push({
        name: preset.label,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  checks.push({ name: 'Data', ok: true, detail: getAppPaths().data });
  for (const check of checks) {
    const mark = check.ok
      ? check.warn === true
        ? chalk.yellow('!')
        : chalk.green('✓')
      : chalk.red('✗');
    process.stdout.write(`${mark} ${check.name}: ${check.detail}\n`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}
