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
import { getCredentialsPath, resolveApiKey, saveApiKey } from '../infra/credentials.js';
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
  writeConfigFile,
  type ConfigFile,
} from '../infra/config.js';
import { canonicalWorkspace, getAppPaths } from '../infra/paths.js';
import { fileExists, readJsonFileIfExists } from '../infra/persistence.js';
import { OpenAIProvider } from '../providers/openai.js';
import { detectGitAvailability } from '../tools/git-tools.js';
import type { SessionRecord } from '../types.js';
import { createAgentRuntime, createBaseRuntime, type GlobalOptions } from './runtime.js';
import { renderSessionExport, type SessionExportFormat } from './session-export.js';
import { createEventRenderer, printJson, printResultMessage } from './ui.js';

export interface RunOptions {
  json?: boolean;
  history?: boolean;
  session?: string;
  plan?: boolean;
}

export interface PushOptions {
  yes?: boolean;
  setUpstream?: boolean;
  remote?: string;
  branch?: string;
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
        process.stdout.write(`${result.stdout || '(无差异)'}\n`);
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

const SETUP_SCHEMA_URL = 'https://unpkg.com/codefarmer@0.1.0/schemas/codefarmer.config.schema.json';

export async function initAction(globalOptions: GlobalOptions, force = false): Promise<void> {
  const workspace = await canonicalWorkspace(globalOptions.cwd ?? process.cwd());
  const projectConfigPath = path.join(workspace, 'codefarmer.config.json');
  if ((await fileExists(projectConfigPath)) && !force) {
    throw new ConflictError(`配置已存在: ${projectConfigPath}；使用 --force 覆盖`);
  }
  const initial: ConfigFile = {
    $schema: SETUP_SCHEMA_URL,
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

async function testConnection(baseUrl: string, model: string, apiKey?: string): Promise<void> {
  const progress = spinner();
  progress.start('正在测试 OpenAI 连接');
  try {
    await new OpenAIProvider({
      ...(apiKey === undefined ? {} : { apiKey }),
      baseURL: baseUrl,
      connectionModel: model,
    }).checkConnection();
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

  const model = await text({
    message: 'OpenAI 模型',
    initialValue: defaults.model,
    validate: (value) => (value.trim().length === 0 ? '模型不能为空' : undefined),
  });
  if (isCancel(model)) return abortSetup();

  const baseURL = await text({
    message: 'OpenAI 兼容 API Base URL',
    initialValue: defaults.baseURL,
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
  let apiKey = await resolveApiKey();
  if (process.env.OPENAI_API_KEY) {
    process.stdout.write(`${chalk.green('✓')} 使用环境变量中的 OPENAI_API_KEY。\n`);
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
      message: 'OpenAI API Key（不会写入项目配置，仅保存到本地凭据文件；留空跳过）',
      validate: () => undefined,
    });
    if (isCancel(input)) return abortSetup();
    const trimmed = input.trim();
    if (trimmed.length > 0) {
      apiKey = trimmed;
      const savedPath = await saveApiKey(trimmed);
      process.stdout.write(`${chalk.green('✓')} API Key 已保存到 ${savedPath}\n`);
    } else {
      process.stdout.write(
        `${chalk.yellow('⚠')} 未提供 API Key；运行任务前请设置 OPENAI_API_KEY 环境变量或重新运行 setup。\n`,
      );
    }
  }
  if (apiKey !== undefined) {
    const shouldTest = await confirm({
      message: '是否现在测试连接？',
      initialValue: true,
    });
    if (isCancel(shouldTest)) return abortSetup();
    if (shouldTest) await testConnection(normalizedBaseUrl, model, apiKey);
  }

  const config: ConfigFile = {
    $schema: SETUP_SCHEMA_URL,
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
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    throw new AuthenticationError(
      '缺少 OPENAI_API_KEY；请设置环境变量，或运行 codefarmer setup 保存密钥到本地凭据',
    );
  }
  const runtime = await createBaseRuntime(globalOptions);
  const session = await runtime.sessions.get(id);
  const provider = new OpenAIProvider({
    apiKey,
    baseURL: session.baseURL ?? runtime.config.baseURL,
    connectionModel: runtime.config.model,
  });
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
  const details = await loadConfigDetails({
    cwd: globalOptions.cwd ?? process.cwd(),
    cli: {
      ...(globalOptions.model === undefined ? {} : { model: globalOptions.model }),
      ...(globalOptions.baseURL === undefined ? {} : { baseURL: globalOptions.baseURL }),
      ...(globalOptions.reasoning === undefined ? {} : { reasoning: globalOptions.reasoning }),
      ...(globalOptions.verbosity === undefined ? {} : { verbosity: globalOptions.verbosity }),
      ...(globalOptions.reasoningSummary === undefined
        ? {}
        : { reasoningSummary: globalOptions.reasoningSummary }),
      ...(globalOptions.approval === undefined ? {} : { approval: globalOptions.approval }),
    },
  });
  printJson(details.config);
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
      '凭据不能写入配置；请设置 OPENAI_API_KEY 环境变量，或运行 codefarmer setup 保存到本地凭据',
    );
  }
  const details = await loadConfigDetails({ cwd: globalOptions.cwd ?? process.cwd() });
  const target = project ? details.projectConfigPath : details.userConfigPath;
  const current = (await readJsonFileIfExists<ConfigFile>(target)) ?? {};
  const candidate = { ...current, [key]: parseConfigValue(raw) };
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
  const resolvedKey = await resolveApiKey();
  const keySource = process.env.OPENAI_API_KEY ? '环境变量' : `本地凭据 ${getCredentialsPath()}`;
  checks.push({
    name: 'OPENAI_API_KEY',
    ok: resolvedKey !== undefined,
    detail: resolvedKey === undefined ? '未设置' : `已设置（${keySource}）`,
  });
  checks.push({ name: 'Base URL', ok: true, detail: runtime.config.baseURL });
  if (resolvedKey !== undefined) {
    try {
      await new OpenAIProvider({
        apiKey: resolvedKey,
        baseURL: runtime.config.baseURL,
        connectionModel: runtime.config.model,
      }).checkConnection();
      checks.push({ name: 'OpenAI', ok: true, detail: '连接成功' });
    } catch (error) {
      checks.push({
        name: 'OpenAI',
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
