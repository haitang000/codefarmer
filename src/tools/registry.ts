import type { ToolDefinition, ToolResult } from '../types.js';
import { applyPatch, applyPatchDefinition } from './apply-patch.js';
import { ToolError } from './errors.js';
import {
  listFiles,
  listFilesDefinition,
  readFileDefinition,
  readWorkspaceFile,
  searchText,
  searchTextDefinition,
} from './file-tools.js';
import {
  gitDiff,
  gitDiffDefinition,
  gitLog,
  gitLogDefinition,
  gitShow,
  gitShowDefinition,
  gitStatus,
  gitStatusDefinition,
} from './git-tools.js';
import { failedResult, requireObject } from './output.js';
import { runCommand, runCommandDefinition } from './run-command.js';
import { writeFileDefinition, writeWorkspaceFile } from './write-file.js';
import { todoWriteDefinition, writeTodos } from './todo-write.js';
import { askUser, askUserDefinition } from './ask-user.js';
import { webFetch, webFetchDefinition } from './web-fetch.js';
import { webSearch, webSearchDefinition } from './web-search.js';
import {
  listSkills,
  listSkillsDefinition,
  readSkill,
  readSkillDefinition,
  readSkillResource,
  readSkillResourceDefinition,
} from './skill-tools.js';
import type {
  ApprovalRequest,
  RegisteredTool,
  ResolvedToolContext,
  ToolCall,
  ToolCallResult,
  ToolContextOptions,
  ToolExecutionOptions,
  ToolLifecycleHooks,
} from './types.js';
import { WorkspaceGuard } from './workspace.js';

export type { ToolExecutionOptions, ToolLifecycleHooks } from './types.js';

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

function parseArguments(value: ToolCall['arguments']): Record<string, unknown> {
  if (typeof value !== 'string') return requireObject(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ToolError('INVALID_ARGUMENT', 'Tool arguments are not valid JSON.', {
      cause: error as Error,
    });
  }
  return requireObject(parsed);
}

function validateKnownProperties(
  definition: ToolDefinition,
  arguments_: Record<string, unknown>,
): void {
  const properties = definition.inputSchema.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return;
  const allowed = new Set(Object.keys(properties));
  const unknown = Object.keys(arguments_).find((name) => !allowed.has(name));
  if (unknown !== undefined) {
    throw new ToolError('INVALID_ARGUMENT', `Unknown argument for ${definition.name}: ${unknown}`);
  }
}

function withDuration(result: ToolResult, startedAt: number): ToolResult {
  return { ...result, durationMs: Date.now() - startedAt };
}

async function notifyHook<Arguments extends unknown[]>(
  hook: ((...arguments_: Arguments) => void | Promise<void>) | undefined,
  ...arguments_: Arguments
): Promise<void> {
  if (hook === undefined) return;
  try {
    await hook(...arguments_);
  } catch {
    // Observers must not turn a successful tool call into a failed one.
  }
}

function executionContext(
  context: ResolvedToolContext,
  options: ToolExecutionOptions,
): ResolvedToolContext {
  const hooks = options.hooks;
  const configuredApproval = context.approve;
  const approval =
    options.autoApprove === true
      ? async (request: ApprovalRequest) =>
          request.requireConfirmation === true
            ? ((await configuredApproval?.(request)) ?? false)
            : true
      : configuredApproval;
  const signal = options.signal;
  if (approval === undefined && signal === undefined) return context;

  const effective = {
    ...context,
    ...(approval === undefined ? {} : { approve: approval }),
    ...(signal === undefined ? {} : { signal }),
  };
  if (approval === undefined || hooks === undefined) return effective;

  return {
    ...effective,
    approve: async (request) => {
      await notifyHook(hooks.onApprovalRequest, request, options.call);
      let approved: boolean;
      try {
        approved = await approval(request);
      } catch (error) {
        await notifyHook(hooks.onApprovalResolution, request, false, options.call);
        throw error;
      }
      await notifyHook(hooks.onApprovalResolution, request, approved, options.call);
      return approved;
    },
  };
}

export class ToolRegistry {
  readonly definitions: ToolDefinition[];
  private readonly tools: Map<string, RegisteredTool>;
  private readonly hooks: ToolLifecycleHooks | undefined;

  constructor(tools: RegisteredTool[], options: { hooks?: ToolLifecycleHooks } = {}) {
    this.tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
    this.definitions = tools.map((tool) => tool.definition);
    this.hooks = options.hooks;
  }

  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.definition.readOnly ?? false;
  }

  /** Tool definitions safe to expose while plan mode restricts the agent to inspection. */
  get readOnlyDefinitions(): ToolDefinition[] {
    return this.definitions.filter((definition) => definition.readOnly);
  }

  async execute(call: ToolCall, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    const startedAt = Date.now();
    const hooks = options.hooks ?? this.hooks;
    const execution: ToolExecutionOptions = {
      ...options,
      ...(hooks === undefined ? {} : { hooks }),
      call,
    };
    try {
      await hooks?.beforeTool?.(call);
    } catch (error) {
      const result = withDuration(
        failedResult(
          call.callId,
          call.name,
          new ToolError('HOOK_BLOCKED', error instanceof Error ? error.message : String(error)),
        ),
        startedAt,
      );
      await notifyHook(hooks?.onToolResult, call, result);
      return result;
    }
    await notifyHook(hooks?.onToolStart, call);
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      const result = withDuration(
        failedResult(
          call.callId,
          call.name,
          new ToolError('TOOL_NOT_FOUND', `Unknown tool: ${call.name}`),
        ),
        startedAt,
      );
      await notifyHook(hooks?.onToolResult, call, result);
      return result;
    }
    if (options.plan === true && !tool.definition.readOnly) {
      const result = withDuration(
        failedResult(
          call.callId,
          call.name,
          new ToolError(
            'PLAN_MODE_FORBIDDEN',
            `Plan mode is active; ${call.name} mutates the workspace and cannot run. Finish with a plan instead.`,
          ),
        ),
        startedAt,
      );
      await notifyHook(hooks?.onToolResult, call, result);
      return result;
    }
    let result: ToolResult;
    try {
      const arguments_ = parseArguments(call.arguments);
      validateKnownProperties(tool.definition, arguments_);
      result = withDuration(await tool.execute(arguments_, call.callId, execution), startedAt);
    } catch (error) {
      result = withDuration(failedResult(call.callId, call.name, error), startedAt);
    }
    await notifyHook(hooks?.afterTool, call, result);
    await notifyHook(hooks?.onToolResult, call, result);
    return result;
  }

  async executeMany(
    calls: ToolCall[],
    options: ToolExecutionOptions = {},
  ): Promise<ToolCallResult[]> {
    // Pipeline the batch: consecutive read-only calls run in parallel, and the
    // pipeline only blocks at mutating calls, which execute one at a time in
    // their original order. Read-only calls issued after a mutating call are
    // held until that call finishes, so observable ordering matches a fully
    // sequential run while mixed batches finish much faster.
    const results = new Array<ToolCallResult>(calls.length);
    let chain: Promise<void> = Promise.resolve();
    let group: ToolCall[] = [];
    let groupIndices: number[] = [];

    const flush = (): void => {
      if (group.length === 0) return;
      const batch = group;
      const indices = groupIndices;
      group = [];
      groupIndices = [];
      const next = chain.then(async () => {
        const outputs = await Promise.all(batch.map((call) => this.execute(call, options)));
        outputs.forEach((result, position) => {
          const call = batch[position];
          const index = indices[position];
          if (call === undefined || index === undefined) return;
          results[index] = { callId: call.callId, name: call.name, result };
        });
      });
      chain = next;
    };

    calls.forEach((call, index) => {
      if (this.isReadOnly(call.name)) {
        group.push(call);
        groupIndices.push(index);
        return;
      }
      flush();
      chain = chain.then(async () => {
        results[index] = {
          callId: call.callId,
          name: call.name,
          result: await this.execute(call, options),
        };
      });
    });
    flush();
    await chain;
    return results;
  }
}

export async function createToolRegistry(options: ToolContextOptions): Promise<ToolRegistry> {
  const guard = await WorkspaceGuard.create(options.workspace, options.ignoredPaths ?? []);
  const context: ResolvedToolContext = {
    workspace: guard.root,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.onMutation === undefined ? {} : { onMutation: options.onMutation }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.skillCatalog === undefined ? {} : { skillCatalog: options.skillCatalog }),
    ...(options.allowPrivateAddresses === undefined
      ? {}
      : { allowPrivateAddresses: options.allowPrivateAddresses }),
    ...(options.webSearchEndpoint === undefined
      ? {}
      : { webSearchEndpoint: options.webSearchEndpoint }),
    ...(options.todos === undefined ? {} : { todos: options.todos }),
    ...(options.askUser === undefined ? {} : { askUser: options.askUser }),
  };

  const register = (
    definition: ToolDefinition,
    execute: RegisteredTool['execute'],
  ): RegisteredTool => ({ definition, execute });
  return new ToolRegistry(
    [
      register(listFilesDefinition, (arguments_, callId, options = {}) =>
        listFiles(callId, arguments_, executionContext(context, options), guard),
      ),
      register(readFileDefinition, (arguments_, callId, options = {}) =>
        readWorkspaceFile(callId, arguments_, executionContext(context, options), guard),
      ),
      register(searchTextDefinition, (arguments_, callId, options = {}) =>
        searchText(callId, arguments_, executionContext(context, options), guard),
      ),
      register(applyPatchDefinition, (arguments_, callId, options = {}) =>
        applyPatch(callId, arguments_, executionContext(context, options), guard),
      ),
      register(writeFileDefinition, (arguments_, callId, options = {}) =>
        writeWorkspaceFile(callId, arguments_, executionContext(context, options), guard),
      ),
      register(runCommandDefinition, (arguments_, callId, options = {}) =>
        runCommand(callId, arguments_, executionContext(context, options), guard),
      ),
      register(gitStatusDefinition, (arguments_, callId, options = {}) =>
        gitStatus(callId, arguments_, executionContext(context, options), guard),
      ),
      register(gitDiffDefinition, (arguments_, callId, options = {}) =>
        gitDiff(callId, arguments_, executionContext(context, options), guard),
      ),
      register(gitLogDefinition, (arguments_, callId, options = {}) =>
        gitLog(callId, arguments_, executionContext(context, options), guard),
      ),
      register(gitShowDefinition, (arguments_, callId, options = {}) =>
        gitShow(callId, arguments_, executionContext(context, options), guard),
      ),
      register(webFetchDefinition, (arguments_, callId, options = {}) =>
        webFetch(callId, arguments_, executionContext(context, options)),
      ),
      register(webSearchDefinition, (arguments_, callId, options = {}) =>
        webSearch(callId, arguments_, executionContext(context, options)),
      ),
      register(todoWriteDefinition, (arguments_, callId, options = {}) =>
        writeTodos(callId, arguments_, executionContext(context, options)),
      ),
      register(askUserDefinition, (arguments_, callId, options = {}) =>
        askUser(callId, arguments_, executionContext(context, options)),
      ),
      register(listSkillsDefinition, (arguments_, callId, options = {}) =>
        listSkills(callId, arguments_, executionContext(context, options)),
      ),
      register(readSkillDefinition, (arguments_, callId, options = {}) =>
        readSkill(callId, arguments_, executionContext(context, options)),
      ),
      register(readSkillResourceDefinition, (arguments_, callId, options = {}) =>
        readSkillResource(callId, arguments_, executionContext(context, options)),
      ),
    ],
    options,
  );
}
