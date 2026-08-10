import path from 'node:path';
import { execa } from 'execa';
import type { JsonObject, ToolDefinition, ToolResult } from '../types.js';
import { ToolError } from './errors.js';
import { optionalInteger, optionalString, requiredString, truncateUtf8 } from './output.js';
import type { ResolvedToolContext } from './types.js';
import type { WorkspaceGuard } from './workspace.js';

export const runCommandDefinition: ToolDefinition = {
  name: 'run_command',
  description:
    'Run one executable directly with an argument array. Shell evaluation and dangerous commands are blocked.',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      executable: { type: 'string', minLength: 1 },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: ['string', 'null'], description: 'Workspace-relative directory, or null.' },
      timeoutMs: { type: ['integer', 'null'], minimum: 1, maximum: 120000 },
    },
    required: ['executable', 'args', 'cwd', 'timeoutMs'],
    additionalProperties: false,
  },
};

export type CommandRisk = 'read-only' | 'mutating' | 'blocked';

export interface CommandClassification {
  risk: CommandRisk;
  reason: string;
  requireConfirmation?: boolean;
}

const READ_ONLY_EXECUTABLES = new Set([
  'cat',
  'find',
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'sed',
  'tail',
  'type',
  'where',
  'where.exe',
  'which',
  'wc',
]);

const DANGEROUS_EXECUTABLES = new Set([
  'bcdedit',
  'cipher',
  'dd',
  'diskpart',
  'fdisk',
  'format',
  'halt',
  'init',
  'mkfs',
  'poweroff',
  'reboot',
  'rm',
  'shutdown',
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'diff',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'rev-list',
  'rev-parse',
  'show',
  'status',
  'tag',
]);

function executableName(executable: string): string {
  return path
    .basename(executable)
    .toLowerCase()
    .replace(/\.exe$/u, '');
}

function hasAnyArgument(args: string[], values: Set<string>): boolean {
  return args.some((argument) => values.has(argument.toLowerCase()));
}

function hasOption(args: string[], options: string[]): boolean {
  return args.some((argument) => {
    const lower = argument.toLowerCase();
    return options.some(
      (option) =>
        lower === option ||
        lower.startsWith(`${option}=`) ||
        (option.length === 2 && lower.startsWith(option) && lower.length > option.length),
    );
  });
}

function classifyGit(args: string[]): CommandClassification {
  let index = 0;
  let currentArgument = args.at(index);
  while (currentArgument?.startsWith('-') === true) {
    const argument = currentArgument.toLowerCase();
    if (argument === '--no-pager' || argument === '--paginate') {
      index += 1;
      currentArgument = args.at(index);
      continue;
    }
    return { risk: 'blocked', reason: `Git global option is not allowed: ${currentArgument}` };
  }
  const subcommand = args[index]?.toLowerCase();
  if (subcommand === undefined) {
    return { risk: 'read-only', reason: 'Git help output.' };
  }
  if (subcommand === 'push') {
    return {
      risk: 'mutating',
      reason: 'Git push sends local commits to a remote repository.',
      requireConfirmation: true,
    };
  }
  if (!GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) {
    return { risk: 'blocked', reason: `Git write-capable command is not allowed: ${subcommand}` };
  }
  const remaining = args.slice(index + 1).map((argument) => argument.toLowerCase());
  if (
    remaining.some((argument) =>
      ['--ext-diff', '--textconv', '--exec-path', '--output', '--open-files-in-pager'].some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
    )
  ) {
    return { risk: 'blocked', reason: 'Git option can execute code or write output.' };
  }
  if (subcommand === 'tag' && !remaining.every((argument) => argument.startsWith('-l'))) {
    return { risk: 'blocked', reason: 'Only listing Git tags is allowed.' };
  }
  return {
    risk: 'mutating',
    reason: `Git command is read-only but requires approval outside the scoped Git tools: ${subcommand}`,
  };
}

export function classifyCommand(executable: string, args: string[]): CommandClassification {
  const name = executableName(executable);
  if (name.length === 0 || executable.includes('\0')) {
    return { risk: 'blocked', reason: 'Executable name is invalid.' };
  }
  if (/\.(?:bat|cmd|ps1)$/iu.test(executable)) {
    return { risk: 'blocked', reason: 'Command scripts can bypass argument safety checks.' };
  }
  if (DANGEROUS_EXECUTABLES.has(name) || name.startsWith('mkfs.')) {
    return { risk: 'blocked', reason: `Dangerous system command is not allowed: ${name}` };
  }

  const lowerArgs = args.map((argument) => argument.toLowerCase());
  if (
    new Set(['bash', 'cmd', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh']).has(name)
  ) {
    const shellFlags = new Set([
      '-c',
      '/c',
      '/k',
      '--command',
      '-command',
      '-encodedcommand',
      '-enc',
    ]);
    if (hasAnyArgument(lowerArgs, shellFlags) || hasOption(lowerArgs, [...shellFlags])) {
      return { risk: 'blocked', reason: 'Shell command evaluation is not allowed.' };
    }
    return { risk: 'mutating', reason: 'A shell script can have side effects.' };
  }
  if (
    (name === 'node' && hasOption(lowerArgs, ['-e', '--eval', '-p', '--print'])) ||
    (new Set(['python', 'python3']).has(name) && hasOption(lowerArgs, ['-c'])) ||
    (new Set(['ruby', 'perl']).has(name) && hasOption(lowerArgs, ['-e']))
  ) {
    return { risk: 'blocked', reason: 'Interpreter evaluation is not allowed.' };
  }
  if (name === 'git') return classifyGit(args);
  if (name === 'find') {
    if (hasOption(lowerArgs, ['-exec', '-execdir', '-ok', '-okdir'])) {
      return { risk: 'blocked', reason: 'find may not execute other programs.' };
    }
    if (hasOption(lowerArgs, ['-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])) {
      return { risk: 'mutating', reason: 'find option can modify files.' };
    }
  }
  if (name === 'sed' && hasOption(lowerArgs, ['-i', '--in-place'])) {
    return { risk: 'mutating', reason: 'sed in-place mode modifies files.' };
  }
  if (name === 'rg' && hasOption(lowerArgs, ['--pre'])) {
    return { risk: 'blocked', reason: 'ripgrep preprocessors may execute arbitrary programs.' };
  }
  if (READ_ONLY_EXECUTABLES.has(name)) {
    return {
      risk: 'mutating',
      reason: `${name} can bypass guarded workspace reads and therefore requires approval.`,
    };
  }
  if (
    new Set(['node', 'npm', 'npx', 'pnpm', 'yarn']).has(name) &&
    lowerArgs.every((argument) => ['--version', '-v', '--help', '-h'].includes(argument))
  ) {
    return { risk: 'read-only', reason: 'Version or help output.' };
  }
  return { risk: 'mutating', reason: 'Command may have side effects.' };
}

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:OPENAI_API_KEY|AUTHORIZATION|CREDENTIAL|PRIVATE_?KEY|PASSWORD|PASSWD|SECRET|TOKEN)/iu;

export function sanitiseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name)),
  );
}

function parseArguments(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((argument) => typeof argument === 'string')) {
    throw new ToolError('INVALID_ARGUMENT', 'args must be an array of strings.');
  }
  if (value.length > 256 || value.some((argument) => argument.length > 32_768)) {
    throw new ToolError('INVALID_ARGUMENT', 'Command argument limits were exceeded.');
  }
  if (value.some((argument) => argument.includes('\0'))) {
    throw new ToolError('INVALID_ARGUMENT', 'Command arguments cannot contain NUL bytes.');
  }
  return value;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function hardenGitInvocation(args: string[]): { args: string[]; environment: NodeJS.ProcessEnv } {
  const subcommandIndex = args.findIndex((argument) => !argument.startsWith('-'));
  const subcommand = args[subcommandIndex]?.toLowerCase();
  const safeArgs =
    subcommand !== undefined && ['diff', 'log', 'show'].includes(subcommand)
      ? [
          ...args.slice(0, subcommandIndex + 1),
          '--no-ext-diff',
          '--no-textconv',
          ...args.slice(subcommandIndex + 1),
        ]
      : args;
  return {
    args: ['-c', 'core.fsmonitor=false', ...safeArgs],
    environment: {
      GIT_EXTERNAL_DIFF: '',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    },
  };
}

export async function executeProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maximumBufferBytes: number;
    signal?: AbortSignal;
    environment?: NodeJS.ProcessEnv;
  },
): Promise<ProcessResult> {
  try {
    const result = await execa(executable, args, {
      cwd: options.cwd,
      env: sanitiseEnvironment({ ...process.env, ...options.environment }),
      extendEnv: false,
      timeout: options.timeoutMs,
      maxBuffer: Math.max(options.maximumBufferBytes * 4, 1024 * 1024),
      reject: false,
      shell: false,
      stdin: 'ignore',
      stripFinalNewline: false,
      ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
    });
    return {
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  } catch (error) {
    const value = error as {
      exitCode?: number;
      signal?: string;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
      isMaxBuffer?: boolean;
      message?: string;
    };
    if (value.timedOut === true) {
      return {
        exitCode: value.exitCode ?? null,
        signal: value.signal ?? null,
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? '',
        timedOut: true,
      };
    }
    if (value.isMaxBuffer === true) {
      return {
        exitCode: value.exitCode ?? null,
        signal: value.signal ?? null,
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? '',
        timedOut: false,
      };
    }
    throw new ToolError('COMMAND_FAILED', value.message ?? String(error), {
      cause: error as Error,
    });
  }
}

function renderProcessOutput(result: ProcessResult): string {
  const sections: string[] = [];
  if (result.stdout.length > 0) sections.push(result.stdout);
  if (result.stderr.length > 0) sections.push(`[stderr]\n${result.stderr}`);
  sections.push(`[exit ${result.exitCode === null ? 'none' : String(result.exitCode)}]`);
  return sections.join('\n');
}

export async function runCommand(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const executable = requiredString(arguments_.executable, 'executable');
  const args = parseArguments(arguments_.args);
  // Some gateways stringify a JSON `null` argument into the literal text
  // "null"; treat such values as the workspace root.
  const requestedCwd =
    arguments_.cwd === 'null' || arguments_.cwd === 'undefined'
      ? '.'
      : (optionalString(arguments_.cwd, 'cwd', '.') ?? '.');
  const maximumTimeout = Math.min(context.commandTimeoutMs, 120_000);
  const timeoutMs = optionalInteger(
    arguments_.timeoutMs,
    'timeoutMs',
    maximumTimeout,
    1,
    maximumTimeout,
  );
  const classification = classifyCommand(executable, args);
  if (classification.risk === 'blocked') {
    throw new ToolError('COMMAND_BLOCKED', classification.reason);
  }
  const cwd = await guard.resolveExisting(requestedCwd, { kind: 'directory' });
  if (context.approve !== undefined && classification.risk !== 'read-only') {
    const approved = await context.approve({
      kind: 'command',
      title: classification.requireConfirmation ? 'Push Git changes' : `Run ${path.basename(executable)}`,
      detail: JSON.stringify([executable, ...args]),
      readOnly: false,
      ...(classification.requireConfirmation === true ? { requireConfirmation: true } : {}),
    });
    if (!approved) throw new ToolError('APPROVAL_DENIED', 'The command was rejected by the user.');
  }

  const gitInvocation =
    executableName(executable) === 'git' ? hardenGitInvocation(args) : undefined;
  const result = await executeProcess(executable, gitInvocation?.args ?? args, {
    cwd,
    timeoutMs,
    maximumBufferBytes: context.maxOutputBytes,
    ...(gitInvocation === undefined ? {} : { environment: gitInvocation.environment }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const rendered = truncateUtf8(renderProcessOutput(result), context.maxOutputBytes);
  const data: JsonObject = {
    exitCode: result.exitCode,
    signal: result.signal,
    classification: {
      risk: classification.risk,
      reason: classification.reason,
    },
  };
  if (result.timedOut) {
    return {
      callId,
      toolName: 'run_command',
      success: false,
      output: rendered.text,
      data,
      truncated: rendered.truncated,
      error: {
        code: 'COMMAND_TIMEOUT',
        message: `Command timed out after ${String(timeoutMs)} ms.`,
      },
    };
  }
  if (result.exitCode !== 0) {
    return {
      callId,
      toolName: 'run_command',
      success: false,
      output: rendered.text,
      data,
      truncated: rendered.truncated,
      error: {
        code: 'COMMAND_FAILED',
        message: `Command exited with code ${result.exitCode === null ? 'unknown' : String(result.exitCode)}.`,
      },
    };
  }
  return {
    callId,
    toolName: 'run_command',
    success: true,
    output: rendered.text,
    data,
    truncated: rendered.truncated,
  };
}
