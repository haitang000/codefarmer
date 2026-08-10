import { Command, CommanderError, Option } from 'commander';

import { AppError, ConfigError, EXIT_CODES, formatAppError, toAppError } from './infra/errors.js';
import type {
  ApprovalPolicy,
  LogLevel,
  ReasoningEffort,
  ReasoningSummary,
  TextVerbosity,
} from './types.js';
import { completionScript } from './cli/completions.js';
import {
  configGetAction,
  configListAction,
  configPathAction,
  configSetAction,
  doctorAction,
  initAction,
  pushAction,
  runAction,
  sessionsDeleteAction,
  sessionsExportAction,
  sessionsListAction,
  sessionsRenameAction,
  sessionsShowAction,
  setupAction,
  statusAction,
  undoAction,
} from './cli/commands.js';
import type { PushOptions } from './cli/commands.js';
import type { GlobalOptions } from './cli/runtime.js';
import type { SessionExportFormat } from './cli/session-export.js';

function globals(command: Command): GlobalOptions {
  const options = command.optsWithGlobals<{
    cwd?: string;
    model?: string;
    baseUrl?: string;
    reasoning?: ReasoningEffort;
    verbosity?: TextVerbosity;
    reasoningSummary?: ReasoningSummary;
    approval?: ApprovalPolicy;
    stream?: boolean;
    logLevel?: LogLevel;
    verbose?: boolean;
  }>();
  let root = command;
  while (root.parent !== null) root = root.parent;
  const streamSource = root.getOptionValueSource('stream');
  return {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.verbosity === undefined ? {} : { verbosity: options.verbosity }),
    ...(options.reasoningSummary === undefined
      ? {}
      : { reasoningSummary: options.reasoningSummary }),
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    ...(streamSource === 'cli' || streamSource === 'env' ? { stream: options.stream } : {}),
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
  };
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

async function launchTui(
  globalOptions: GlobalOptions,
  sessionId?: string,
  plan?: boolean,
): Promise<void> {
  if (!isInteractiveTerminal()) {
    program.outputHelp();
    return;
  }
  // Keep the TUI (and its renderer dependencies) out of help, JSON, and piped invocations.
  const { runTui } = await import('./tui/index.js');
  await runTui(globalOptions, sessionId, plan);
}

const program = new Command();
program
  .name('codefarmer')
  .description('安全、可审计的 OpenAI Coding Agent CLI')
  .usage('[选项] [命令]')
  .version('0.1.0', '-V, --version', '显示版本')
  .helpOption('-h, --help', '显示帮助')
  .helpCommand('help [command]', '显示命令帮助')
  .option('--cwd <path>', '工作区目录')
  .option('--model <model>', 'OpenAI 模型')
  .option('--base-url <url>', 'OpenAI 兼容 API Base URL')
  .addOption(
    new Option('--reasoning <effort>', '推理强度').choices([
      'auto',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]),
  )
  .addOption(new Option('--verbosity <level>', '文本详细度').choices(['low', 'medium', 'high']))
  .addOption(
    new Option('--reasoning-summary <mode>', '推理摘要').choices([
      'none',
      'auto',
      'concise',
      'detailed',
    ]),
  )
  .addOption(new Option('--approval <policy>', '审批策略').choices(['ask', 'auto', 'read-only']))
  .option('--no-stream', '关闭流式文本输出')
  .addOption(
    new Option('--log-level <level>', '日志级别').choices([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
      'silent',
    ]),
  )
  .option('--verbose', '显示详细诊断信息')
  .action(async () => {
    await launchTui(globals(program));
  });

program
  .command('tui')
  .description('启动全屏终端界面')
  .option('--session <id>', '继续已有会话')
  .option('--plan', '以计划模式启动：只读探索，不修改文件')
  .action(async (options: { session?: string; plan?: boolean }, command: Command) => {
    await launchTui(globals(command), options.session, options.plan);
  });

program
  .command('init')
  .description('初始化工作区配置')
  .option('--force', '覆盖已有配置')
  .action(async (options: { force?: boolean }, command: Command) =>
    initAction(globals(command), options.force ?? false),
  );

program
  .command('setup')
  .description('交互式引导完成模型、Base URL、审批等配置')
  .option('--force', '覆盖已有配置，不再询问')
  .action(async (options: { force?: boolean }, command: Command) =>
    setupAction(globals(command), options.force ?? false),
  );

program
  .command('run')
  .description('执行一次性编码任务')
  .argument('<prompt...>', '任务描述')
  .option('--json', '仅输出机器可读 JSON')
  .option('--no-history', '不保存本地会话历史')
  .option('--session <id>', '继续已有会话')
  .option('--plan', '计划模式：只允许只读工具，输出实施方案而不修改文件')
  .action(
    async (
      prompt: string[],
      options: { json?: boolean; history?: boolean; session?: string; plan?: boolean },
      command: Command,
    ) => {
      await runAction(prompt, globals(command), options);
    },
  );

program
  .command('chat')
  .description('启动 TUI 交互会话')
  .option('--session <id>', '继续已有会话')
  .option('--plan', '以计划模式启动：只读探索，不修改文件')
  .action(async (options: { session?: string; plan?: boolean }, command: Command) => {
    await launchTui(globals(command), options.session, options.plan);
  });

program
  .command('status')
  .description('显示工作区、Git、配置和会话状态')
  .action(async (_options: unknown, command: Command) => statusAction(globals(command)));

program
  .command('undo')
  .description('撤销最近一次 Agent 文件变更')
  .option('--session <id>', '只撤销指定会话的变更')
  .action(async (options: { session?: string }, command: Command) =>
    undoAction(globals(command), options.session),
  );

program
  .command('push')
  .description('推送当前分支的提交到远程仓库')
  .option('--yes', '跳过确认（非交互环境推送必须使用）')
  .option('-u, --set-upstream', '推送并设置上游分支（用于首次推送新分支）')
  .option('--remote <name>', '远程仓库名称（默认取上游远程，否则 origin）')
  .option('--branch <name>', '要推送的分支（默认当前分支）')
  .action(async (options: PushOptions, command: Command) => pushAction(globals(command), options));

const sessions = program.command('sessions').description('管理本地会话');
sessions
  .command('list')
  .description('列出会话')
  .action(async (_options: unknown, command: Command) => sessionsListAction(globals(command)));
sessions
  .command('show')
  .description('显示会话 JSON')
  .argument('<id>')
  .action(async (id: string, _options: unknown, command: Command) =>
    sessionsShowAction(globals(command), id),
  );
sessions
  .command('resume')
  .description('在 TUI 中恢复会话')
  .argument('<id>')
  .action(async (id: string, _options: unknown, command: Command) => {
    await launchTui(globals(command), id);
  });
sessions
  .command('delete')
  .description('删除本地会话')
  .argument('<id>')
  .action(async (id: string, _options: unknown, command: Command) =>
    sessionsDeleteAction(globals(command), id),
  );
sessions
  .command('rename')
  .description('重命名会话（设置或覆盖标题）')
  .argument('<id>')
  .argument('<title>')
  .action(async (id: string, title: string, _options: unknown, command: Command) =>
    sessionsRenameAction(globals(command), id, title),
  );

sessions
  .command('export')
  .description('导出会话为 Markdown 或 JSON')
  .argument('<id>')
  .addOption(
    new Option('--format <format>', '导出格式').choices(['markdown', 'json']).default('markdown'),
  )
  .option('--output <path>', '输出文件路径（默认打印到标准输出）')
  .action(
    async (
      id: string,
      options: { format?: SessionExportFormat; output?: string },
      command: Command,
    ) => sessionsExportAction(globals(command), id, options.format ?? 'markdown', options.output),
  );

const config = program.command('config').description('查看或修改配置');
config
  .command('list')
  .description('显示合并后的配置')
  .action(async (_options: unknown, command: Command) => configListAction(globals(command)));
config
  .command('get')
  .argument('<key>')
  .description('读取配置项')
  .action(async (key: string, _options: unknown, command: Command) =>
    configGetAction(globals(command), key),
  );
config
  .command('set')
  .argument('<key>')
  .argument('<value>')
  .description('写入用户配置；使用 --project 写入项目配置')
  .option('--project', '写入项目配置')
  .action(async (key: string, value: string, options: { project?: boolean }, command: Command) =>
    configSetAction(globals(command), key, value, options.project ?? false),
  );
config
  .command('path')
  .description('显示用户和项目配置路径')
  .action(async (_options: unknown, command: Command) => configPathAction(globals(command)));

program
  .command('doctor')
  .description('检查运行环境和 OpenAI 连接')
  .action(async (_options: unknown, command: Command) => doctorAction(globals(command)));

program
  .command('completions')
  .description('生成 bash / zsh / fish 补全脚本')
  .argument('<shell>', '补全脚本类型：bash、zsh 或 fish')
  .action((shell: string) => {
    if (!/^(bash|zsh|fish)$/.test(shell)) {
      throw new ConfigError(`不支持的补全脚本类型：${shell}（仅支持 bash、zsh、fish）`);
    }
    process.stdout.write(completionScript(program, 'codefarmer', shell));
  });

program.showSuggestionAfterError();

function overrideCommandExits(command: Command): void {

  command.exitOverride();
  command.commands.forEach(overrideCommandExits);
}

overrideCommandExits(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode =
      error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2;
  } else {
    const appError = toAppError(error);
    const verbose = program.opts<{ verbose?: boolean }>().verbose ?? false;
    process.stderr.write(`${formatAppError(appError, verbose)}\n`);
    process.exitCode = appError instanceof AppError ? appError.exitCode : EXIT_CODES.failure;
  }
}
