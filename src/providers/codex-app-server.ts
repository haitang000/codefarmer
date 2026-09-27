import { randomUUID } from 'node:crypto';
import { execa } from 'execa';

import type { ApprovalDecision, ApprovalRequest } from '../core/approval.js';
import type { RunTurnOptions } from '../core/agent.js';
import type { AgentRunResult } from '../core/runtime-types.js';
import type { SessionStore } from '../core/session-store.js';
import { ProviderError } from '../infra/errors.js';
import { sanitiseEnvironment } from '../tools/run-command.js';
import type {
  CodeFarmerConfig,
  ProviderEvent,
  ProviderToolCall,
  SessionRecord,
  TokenUsage,
  ToolResult,
} from '../types.js';
import type { SkillCatalog, SkillDescriptor } from '../types.js';

type JsonObject = Record<string, unknown>;

function startAppServerProcess() {
  return execa('codex', ['app-server', '--listen', 'stdio://'], {
    env: sanitiseEnvironment(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
  });
}

type AppServerProcess = ReturnType<typeof startAppServerProcess>;

interface RpcNotification {
  method: string;
  params: JsonObject;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'number' && Number.isFinite(field)) return field;
  }
  return undefined;
}

function rpcError(value: unknown): Error {
  if (isObject(value)) {
    const message = stringField(value, 'message') ?? 'Codex App Server request failed';
    const code = numberField(value, 'code');
    return new ProviderError(
      code === undefined ? message : `${message} (JSON-RPC ${String(code)})`,
    );
  }
  return new ProviderError('Codex App Server returned an invalid JSON-RPC error');
}

/** JSON-RPC client for the local Codex App Server stdio transport. */
export class CodexAppServerClient {
  private readonly child: AppServerProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(notification: RpcNotification) => void>();
  private readonly serverRequestListeners = new Set<
    (request: RpcNotification) => Promise<void> | void
  >();
  private nextRequestId = 1;
  private lineBuffer = '';
  private closed = false;

  private constructor(child: AppServerProcess) {
    this.child = child;
    child.stdout.on('data', (chunk: Buffer | string) => this.consume(String(chunk)));
    // Keep stderr drained without forwarding diagnostic text that might contain
    // user paths or other local context into the terminal transcript.
    child.stderr.on('data', () => undefined);
    void child.then(
      () => this.failPending(new ProviderError('Codex App Server exited')),
      (error: unknown) => this.failPending(this.processError(error)),
    );
    child.on('error', (error: Error) => this.failPending(this.processError(error)));
  }

  public static async connect(): Promise<CodexAppServerClient> {
    let child: AppServerProcess;
    try {
      child = startAppServerProcess();
    } catch (error) {
      throw new ProviderError(
        `无法启动 Codex App Server；请先安装并配置 Codex CLI（codex app-server）。${error instanceof Error ? ` ${error.message}` : ''}`,
      );
    }
    const client = new CodexAppServerClient(child);
    try {
      await client.request('initialize', {
        clientInfo: { name: 'codefarmer', title: 'CodeFarmer', version: '0.2.0-beta1' },
      });
      client.notify('initialized', {});
      return client;
    } catch (error) {
      await client.close();
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|ENOENT/iu.test(message)) {
        throw new ProviderError('未找到 Codex CLI。请安装 Codex CLI 并确保 `codex` 在 PATH 中。', {
          cause: error,
        });
      }
      throw error;
    }
  }

  public onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onServerRequest(listener: (request: RpcNotification) => Promise<void> | void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  public async request<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    if (this.closed) throw new ProviderError('Codex App Server connection is closed');
    const id = this.nextRequestId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      this.write({ id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return (await result) as T;
  }

  public notify(method: string, params: JsonObject = {}): void {
    if (this.closed) return;
    this.write({ method, params });
  }

  public respond(method: string, id: number | string, response: JsonObject): void {
    if (!this.closed) this.write({ method, id, response });
  }

  public async account(): Promise<JsonObject | undefined> {
    const result = await this.request('account/read', { refreshToken: false });
    return isObject(result.account) ? result.account : undefined;
  }

  public async listModels(): Promise<string[]> {
    const result = await this.request('model/list', {
      includeHidden: false,
      limit: 100,
    });
    const entries = Array.isArray(result.data) ? result.data : [];
    return entries
      .filter(isObject)
      .map((entry) => ({
        model: stringField(entry, 'model') ?? stringField(entry, 'id'),
        isDefault: entry.isDefault === true,
      }))
      .filter((entry): entry is { model: string; isDefault: boolean } => entry.model !== undefined)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
      .map((entry) => entry.model);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new ProviderError('Codex App Server connection was closed'));
    this.child.kill('SIGTERM');
    await this.child.catch(() => undefined);
  }

  private write(message: JsonObject): void {
    const stdin = this.child.stdin;
    if (stdin.destroyed) throw new ProviderError('Codex App Server stdin is unavailable');
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.lineBuffer += chunk;
    for (;;) {
      const newline = this.lineBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.failPending(new ProviderError('Codex App Server sent malformed JSONL'));
        continue;
      }
      if (!isObject(message)) continue;
      if (
        typeof message.id === 'number' &&
        (message.result !== undefined || message.error !== undefined)
      ) {
        const pending = this.pending.get(message.id);
        if (pending === undefined) continue;
        this.pending.delete(message.id);
        if (message.error !== undefined) pending.reject(rpcError(message.error));
        else pending.resolve(message.result);
        continue;
      }
      if (typeof message.method === 'string' && isObject(message.params)) {
        if (typeof message.id === 'number' || typeof message.id === 'string') {
          void this.handleServerRequest(message.id, message.method, message.params);
        } else {
          const notification = { method: message.method, params: message.params };
          for (const listener of this.listeners) listener(notification);
        }
      }
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    if (method === 'account/chatgptAuthTokens/refresh') {
      this.respond(method, id, {});
      return;
    }
    for (const listener of this.serverRequestListeners) {
      try {
        await listener({ method, params: { ...params, _requestId: id } });
        return;
      } catch {
        this.respond(method, id, { decision: 'decline' });
        return;
      }
    }
    this.respond(method, id, { decision: 'decline' });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private processError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return /ENOENT|not found/iu.test(message)
      ? new ProviderError('未找到 Codex CLI。请安装 Codex CLI 并确保 `codex` 在 PATH 中。', {
          cause: error,
        })
      : new ProviderError(`Codex App Server 进程失败：${message}`, { cause: error });
  }
}

export interface CodexLoginResult {
  loginId: string;
  authUrl: string;
  completed: Promise<{ success: boolean; error?: string }>;
}

export async function beginChatGptLogin(client: CodexAppServerClient): Promise<CodexLoginResult> {
  let resolveCompleted: ((value: { success: boolean; error?: string }) => void) | undefined;
  const completed = new Promise<{ success: boolean; error?: string }>((resolve) => {
    resolveCompleted = resolve;
  });
  const loginIdRef: { current: string | undefined } = { current: undefined };
  const unsubscribe = client.onNotification((notification) => {
    if (notification.method !== 'account/login/completed') return;
    if (stringField(notification.params, 'loginId') !== loginIdRef.current) return;
    const success = notification.params.success === true;
    const error = stringField(notification.params, 'error');
    resolveCompleted?.({ success, ...(error === undefined ? {} : { error }) });
    unsubscribe();
  });
  const started = await client.request('account/login/start', {
    type: 'chatgpt',
    useHostedLoginSuccessPage: true,
    appBrand: 'chatgpt',
  });
  const loginId = stringField(started, 'loginId');
  const authUrl = stringField(started, 'authUrl');
  if (loginId === undefined || authUrl === undefined) {
    unsubscribe();
    throw new ProviderError('Codex App Server did not return a ChatGPT login URL');
  }
  loginIdRef.current = loginId;
  return { loginId, authUrl, completed };
}

function parseUsageBreakdown(usage: JsonObject): TokenUsage | undefined {
  const inputTokens = numberField(usage, 'inputTokens', 'input_tokens');
  const outputTokens = numberField(usage, 'outputTokens', 'output_tokens');
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const reasoningTokens = numberField(
    usage,
    'reasoningTokens',
    'reasoning_tokens',
    'reasoningOutputTokens',
    'reasoning_output_tokens',
  );
  const cachedInputTokens = numberField(usage, 'cachedInputTokens', 'cached_input_tokens');
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: numberField(usage, 'totalTokens', 'total_tokens') ?? input + output,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function parseTokenUsage(params: JsonObject): { last: TokenUsage; total?: TokenUsage } | undefined {
  const snapshot = isObject(params.tokenUsage)
    ? params.tokenUsage
    : isObject(params.usage)
      ? params.usage
      : params;
  const last = isObject(snapshot.last)
    ? parseUsageBreakdown(snapshot.last)
    : parseUsageBreakdown(snapshot);
  if (last === undefined) return undefined;
  const total = isObject(snapshot.total) ? parseUsageBreakdown(snapshot.total) : undefined;
  return { last, ...(total === undefined ? {} : { total }) };
}

function approvalSummary(
  method: string,
  params: JsonObject,
):
  | {
      request: ApprovalRequest;
      requestId: number | string;
      command: boolean;
    }
  | undefined {
  const rawId = params._requestId;
  if (typeof rawId !== 'number' && typeof rawId !== 'string') return undefined;
  const reason = stringField(params, 'reason');
  const command = stringField(params, 'command');
  const cwd = stringField(params, 'cwd');
  const grantRoot = stringField(params, 'grantRoot');
  const network = isObject(params.networkApprovalContext)
    ? params.networkApprovalContext
    : undefined;
  const fileChange = method.includes('fileChange');
  const detail = fileChange
    ? [reason, grantRoot === undefined ? undefined : `Path: ${grantRoot}`]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join('\n') || 'Codex requests approval for a file change.'
    : network !== undefined
      ? `Network access: ${stringField(network, 'host') ?? 'unknown host'} (${stringField(network, 'protocol') ?? 'unknown protocol'})`
      : [command, cwd === undefined ? undefined : `Working directory: ${cwd}`, reason]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .join('\n') || 'Codex requests approval to run a command.';
  const commandText = `${command ?? ''} ${JSON.stringify(params.commandActions ?? '')}`;
  const requireConfirmation =
    network !== undefined ||
    (/\bgit\b/iu.test(commandText) && /\bpush\b/iu.test(commandText)) ||
    /git[_ -]*push/iu.test(commandText);
  return {
    request: {
      kind: fileChange ? 'patch' : 'command',
      title: fileChange
        ? 'Codex requests a file change'
        : network !== undefined
          ? 'Codex requests network access'
          : 'Codex requests a command',
      detail,
      ...(requireConfirmation ? { requireConfirmation: true } : {}),
    },
    requestId: rawId,
    command: !fileChange,
  };
}

export interface CodexRunnerOptions {
  client: CodexAppServerClient;
  config: CodeFarmerConfig;
  workspace: string;
  sessionStore?: SessionStore;
  history: boolean;
  skills?: SkillCatalog;
  decideApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  hasPermission: (request: ApprovalRequest) => boolean;
  applyPermission: (request: ApprovalRequest, decision: ApprovalDecision) => Promise<boolean>;
}

function ephemeralCodexSession(workspace: string, model: string, baseURL: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    workspace,
    provider: 'codex',
    model,
    baseURL,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    messages: [],
    toolCalls: [],
  };
}

function selectedSkills(
  catalog: SkillCatalog | undefined,
  refs: string[] | undefined,
): SkillDescriptor[] {
  if (catalog === undefined || refs === undefined) return [];
  return refs
    .map((ref) => catalog.get(ref))
    .filter((skill): skill is SkillDescriptor => skill !== undefined);
}

function turnSandbox(workspace: string, readOnly: boolean): JsonObject {
  if (readOnly)
    return {
      type: 'readOnly',
      access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [workspace] },
    };
  return {
    type: 'workspaceWrite',
    writableRoots: [workspace],
    readOnlyAccess: {
      type: 'restricted',
      includePlatformDefaults: true,
      readableRoots: [workspace],
    },
    networkAccess: false,
  };
}

function appServerApprovalPolicy(policy: CodeFarmerConfig['approval'], readOnly: boolean): string {
  return policy !== 'read-only' && !readOnly ? 'onRequest' : 'never';
}

export class CodexAppServerRunner {
  private readonly activeTurn = new Map<string, (notification: RpcNotification) => void>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeRequests: () => void;
  private autoTurn = false;

  public constructor(private readonly options: CodexRunnerOptions) {
    this.unsubscribe = options.client.onNotification((notification) => {
      for (const listener of this.activeTurn.values()) listener(notification);
    });
    this.unsubscribeRequests = options.client.onServerRequest(async (request) => {
      if (
        request.method === 'item/commandExecution/requestApproval' ||
        request.method === 'item/fileChange/requestApproval'
      ) {
        await this.handleApproval(request.method, request.params);
      } else {
        throw new ProviderError(`Unsupported Codex App Server request: ${request.method}`);
      }
    });
  }

  public async listModels(): Promise<readonly string[]> {
    return this.options.client.listModels();
  }

  public async dispose(): Promise<void> {
    this.unsubscribe();
    this.unsubscribeRequests();
    await this.options.client.close();
  }

  public async run(prompt: string, runOptions: RunTurnOptions = {}): Promise<AgentRunResult> {
    const history = runOptions.history ?? this.options.history;
    const store = history ? this.options.sessionStore : undefined;
    const session =
      runOptions.session ??
      (store === undefined
        ? ephemeralCodexSession(
            this.options.workspace,
            this.options.config.model,
            this.options.config.baseURL,
          )
        : await store.createSession(
            'codex',
            this.options.config.model,
            this.options.config.baseURL,
          ));
    if (signalAborted(runOptions.signal)) {
      session.status = 'cancelled';
      session.error = { code: 'INTERRUPTED', message: 'Turn cancelled before it started.' };
      if (store !== undefined) await store.save(session);
      return {
        sessionId: session.id,
        status: 'cancelled',
        message: '',
        toolCalls: [],
        usage: session.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
    const selectedModel =
      this.options.config.model === 'codex-default'
        ? (await this.options.client.listModels())[0]
        : this.options.config.model;
    const model = selectedModel ?? undefined;
    if (session.codexThreadId === undefined) {
      const started = await this.options.client.request('thread/start', {
        cwd: this.options.workspace,
        ...(model === undefined ? {} : { model }),
      });
      const thread = isObject(started.thread) ? started.thread : undefined;
      const threadId = thread === undefined ? undefined : stringField(thread, 'id');
      if (threadId === undefined)
        throw new ProviderError('Codex App Server did not return a thread id');
      session.codexThreadId = threadId;
    } else {
      await this.options.client.request('thread/resume', {
        threadId: session.codexThreadId,
        cwd: this.options.workspace,
        ...(model === undefined ? {} : { model }),
      });
    }
    if (model !== undefined) session.model = model;
    const threadId = session.codexThreadId;
    const deleteThreadAfterRun =
      store === undefined && runOptions.session?.codexThreadId === undefined;
    const now = new Date().toISOString();
    session.messages.push({ id: randomUUID(), role: 'user', content: prompt, createdAt: now });
    if (store !== undefined) await store.save(session);

    const readOnly = runOptions.plan === true || this.options.config.approval === 'read-only';
    const instructions = [
      `CodeFarmer workspace: ${this.options.workspace}. Keep all file reads and writes inside this workspace. Do not commit or push changes.`,
      `Reply in ${this.options.config.language === 'zh-CN' ? 'Simplified Chinese' : 'English'} unless the user requests another language.`,
      ...(runOptions.plan === true
        ? ['Plan mode: inspect and propose a concrete implementation plan only; make no changes.']
        : []),
      ...(runOptions.auto === true
        ? [
            'Auto mode: state a concise plan and then complete it without asking between ordinary workspace operations. Explicitly confirm git push.',
          ]
        : []),
    ].join('\n');
    const skills = selectedSkills(this.options.skills, runOptions.skills);
    const input: JsonObject[] = [
      { type: 'text', text: `${instructions}\n\nUser task:\n${prompt}` },
      ...skills.map((skill) => ({ type: 'skill', name: skill.name, path: skill.skillFile })),
    ];
    const approvalPolicy = appServerApprovalPolicy(this.options.config.approval, readOnly);
    this.autoTurn = runOptions.auto === true;
    const activeId = randomUUID();
    const activityResults: AgentRunResult['toolCalls'] = [];
    let outputText = '';
    let turnId: string | undefined;
    let latestUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let latestTotalUsage: TokenUsage | undefined;
    let completedResolve: ((turn: JsonObject) => void) | undefined;
    const completed = new Promise<JsonObject>((resolve) => {
      completedResolve = resolve;
    });
    const onNotification = (notification: RpcNotification): void => {
      const params = notification.params;
      if (notification.method === 'turn/started' && isObject(params.turn)) {
        turnId = stringField(params.turn, 'id') ?? turnId;
      } else if (notification.method === 'item/agentMessage/delta') {
        const delta = stringField(params, 'delta');
        if (delta !== undefined) {
          outputText += delta;
          runOptions.onEvent?.({ type: 'text_delta', delta });
        }
      } else if (notification.method === 'item/reasoning/summaryTextDelta') {
        const delta = stringField(params, 'delta');
        if (delta !== undefined) runOptions.onEvent?.({ type: 'reasoning_delta', delta });
      } else if (notification.method === 'thread/tokenUsage/updated') {
        const usage = parseTokenUsage(params);
        if (usage !== undefined) {
          latestUsage = usage.last;
          latestTotalUsage = usage.total ?? latestTotalUsage;
        }
        runOptions.onEvent?.({ type: 'usage', usage: latestUsage });
      } else if (notification.method === 'item/started' && isObject(params.item)) {
        this.emitActivity(params.item, 'running', activityResults, runOptions.onEvent);
      } else if (notification.method === 'item/completed' && isObject(params.item)) {
        this.emitActivity(params.item, undefined, activityResults, runOptions.onEvent);
      } else if (notification.method === 'turn/completed' && isObject(params.turn)) {
        completedResolve?.(params.turn);
      } else if (notification.method === 'warning') {
        const message = stringField(params, 'message');
        if (message !== undefined)
          runOptions.onEvent?.({
            type: 'error',
            error: { code: 'CODEX_WARNING', message, retryable: false },
          });
      }
    };
    this.activeTurn.set(activeId, onNotification);
    const abort = (): void => {
      void this.options.client
        .request('turn/interrupt', {
          threadId,
          ...(turnId === undefined ? {} : { turnId }),
        })
        .catch(() => undefined);
    };
    runOptions.signal?.addEventListener('abort', abort, { once: true });
    if (signalAborted(runOptions.signal)) abort();
    try {
      const started = await this.options.client.request('turn/start', {
        threadId,
        input,
        cwd: this.options.workspace,
        approvalPolicy,
        sandboxPolicy: turnSandbox(this.options.workspace, readOnly),
        ...(model === undefined ? {} : { model }),
        ...(this.options.config.reasoning === 'auto'
          ? {}
          : { effort: this.options.config.reasoning }),
        summary: this.options.config.reasoningSummary,
      });
      if (isObject(started.turn)) turnId = stringField(started.turn, 'id') ?? turnId;
      if (signalAborted(runOptions.signal)) abort();
      const finalTurn = await completed;
      const status = stringField(finalTurn, 'status');
      const turnError = isObject(finalTurn.error)
        ? stringField(finalTurn.error, 'message')
        : undefined;
      if (outputText.length === 0 && status === 'completed') {
        const items = Array.isArray(finalTurn.items) ? finalTurn.items.filter(isObject) : [];
        const finalMessage = items.find((item) => item.type === 'agentMessage');
        const text = finalMessage === undefined ? undefined : stringField(finalMessage, 'text');
        if (text !== undefined) {
          outputText = text;
          runOptions.onEvent?.({
            type: 'response_completed',
            responseId: turnId ?? threadId,
            outputText: text,
          });
        }
      }
      const completedAt = new Date().toISOString();
      if (outputText.length > 0) {
        session.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: outputText,
          createdAt: completedAt,
          ...(turnId === undefined ? {} : { responseId: turnId }),
        });
      }
      session.status =
        status === 'interrupted' ? 'cancelled' : status === 'failed' ? 'failed' : 'completed';
      session.usage = latestTotalUsage ?? addUsage(session.usage, latestUsage);
      session.toolCalls.push(
        ...activityResults.map((call) => ({
          callId: call.id,
          toolName: call.name,
          arguments: call.arguments as SessionRecord['toolCalls'][number]['arguments'],
          success: call.result.success,
          ...(call.result.error?.code === 'APPROVAL_DENIED' ? { approved: false } : {}),
          ...(call.result.output.length === 0
            ? {}
            : { outputSummary: call.result.output.slice(0, 500) }),
          ...(call.result.error === undefined ? {} : { error: call.result.error.message }),
          startedAt: completedAt,
          completedAt,
        })),
      );
      if (store !== undefined) await store.save(session);
      const fallbackMessage =
        status === 'interrupted' ? 'Turn interrupted.' : 'Codex completed without a text response.';
      const message =
        outputText.length > 0
          ? outputText
          : turnError !== undefined && turnError.length > 0
            ? turnError
            : fallbackMessage;
      if (turnError !== undefined)
        runOptions.onEvent?.({
          type: 'error',
          error: { code: 'CODEX_TURN_FAILED', message: turnError, retryable: false },
        });
      return {
        sessionId: session.id,
        status:
          session.status === 'cancelled'
            ? 'cancelled'
            : session.status === 'failed'
              ? 'failed'
              : 'completed',
        message,
        ...(turnId === undefined ? {} : { responseId: turnId }),
        toolCalls: activityResults,
        usage: latestUsage,
        ...(turnError === undefined
          ? {}
          : { error: { code: 'CODEX_TURN_FAILED', message: turnError } }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.status = signalAborted(runOptions.signal) ? 'cancelled' : 'failed';
      session.error = {
        code: session.status === 'cancelled' ? 'INTERRUPTED' : 'CODEX_APP_SERVER_ERROR',
        message,
      };
      if (store !== undefined) await store.save(session);
      return {
        sessionId: session.id,
        status: session.status,
        message,
        toolCalls: activityResults,
        usage: latestUsage,
        error: { code: session.error.code, message },
      };
    } finally {
      runOptions.signal?.removeEventListener('abort', abort);
      this.activeTurn.delete(activeId);
      this.autoTurn = false;
      if (deleteThreadAfterRun) {
        await this.options.client.request('thread/delete', { threadId }).catch(() => undefined);
      }
    }
  }

  private async handleApproval(method: string, params: JsonObject): Promise<void> {
    const pending = approvalSummary(method, params);
    if (pending === undefined) return;
    let decision: ApprovalDecision;
    if (
      this.options.hasPermission(pending.request) &&
      pending.request.requireConfirmation !== true
    ) {
      decision = { approved: true, scope: 'workspace' };
    } else if (this.autoTurn && pending.request.requireConfirmation !== true) {
      decision = { approved: true, scope: 'once' };
    } else {
      decision = await this.options.decideApproval(pending.request);
      decision = {
        ...decision,
        approved: await this.options.applyPermission(pending.request, decision),
      };
    }
    this.options.client.respond(method, pending.requestId, {
      decision: decision.approved
        ? decision.scope === 'session'
          ? 'acceptForSession'
          : 'accept'
        : 'decline',
    });
  }

  private emitActivity(
    item: JsonObject,
    forcedStatus: 'running' | undefined,
    results: AgentRunResult['toolCalls'],
    onEvent: ((event: ProviderEvent) => void) | undefined,
  ): void {
    const type = stringField(item, 'type');
    if (type !== 'commandExecution' && type !== 'fileChange' && type !== 'mcpToolCall') return;
    const id = stringField(item, 'id');
    if (id === undefined) return;
    const name =
      type === 'commandExecution'
        ? 'run_command'
        : type === 'fileChange'
          ? 'file_change'
          : (stringField(item, 'tool') ?? 'mcp_tool');
    const argumentsValue =
      type === 'commandExecution'
        ? { command: item.command, cwd: item.cwd }
        : type === 'fileChange'
          ? { changes: item.changes }
          : item.arguments;
    const call: ProviderToolCall = {
      callId: id,
      name,
      arguments: JSON.stringify(argumentsValue ?? {}),
    };
    const rawStatus = stringField(item, 'status');
    const status =
      forcedStatus ??
      (rawStatus === 'declined' ? 'declined' : rawStatus === 'failed' ? 'failed' : 'succeeded');
    const output = stringField(item, 'aggregatedOutput') ?? stringField(item, 'error');
    onEvent?.({
      type: 'codex_activity',
      call,
      status,
      ...(output === undefined ? {} : { output }),
    });
    if (forcedStatus !== undefined) return;
    const success = status === 'succeeded';
    const durationMs = numberField(item, 'durationMs');
    const result: ToolResult = {
      callId: id,
      toolName: name,
      success,
      output:
        output ??
        (success ? 'completed' : status === 'declined' ? 'Approval declined' : 'Tool failed'),
      ...(!success
        ? {
            error: {
              code: status === 'declined' ? 'APPROVAL_DENIED' : 'CODEX_TOOL_FAILED',
              message:
                output ?? (status === 'declined' ? 'Approval declined' : 'Codex tool failed'),
            },
          }
        : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    const existingIndex = results.findIndex((entry) => entry.id === id);
    const callResult = { id, name, arguments: argumentsValue ?? {}, result };
    if (existingIndex < 0) results.push(callResult);
    else results[existingIndex] = callResult;
  }
}

function addUsage(previous: TokenUsage | undefined, current: TokenUsage): TokenUsage {
  if (previous === undefined) return { ...current, requestCount: 1 };
  return {
    inputTokens: previous.inputTokens + current.inputTokens,
    outputTokens: previous.outputTokens + current.outputTokens,
    totalTokens: previous.totalTokens + current.totalTokens,
    ...(previous.reasoningTokens === undefined && current.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: (previous.reasoningTokens ?? 0) + (current.reasoningTokens ?? 0) }),
    requestCount: (previous.requestCount ?? 0) + 1,
  };
}
