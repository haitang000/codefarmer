import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

import type { Logger } from 'pino';

import { PolicyApprovalController, type ApprovalRequest } from '../core/approval.js';
import { AgentRunner } from '../core/agent.js';
import { SessionStore } from '../core/session-store.js';
import { TransactionStore } from '../core/transaction-store.js';
import { resolveApiKey } from '../infra/credentials.js';
import { AuthenticationError, ConfigError } from '../infra/errors.js';
import { loadConfig, type ConfigOverrides } from '../infra/config.js';
import { createLogger } from '../infra/logger.js';
import { canonicalWorkspace } from '../infra/paths.js';
import { OpenAIProvider } from '../providers/openai.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ToolLifecycleHooks } from '../tools/types.js';
import type { CodeFarmerConfig, SessionRecord } from '../types.js';
import { promptForApproval } from './ui.js';

export interface GlobalOptions {
  cwd?: string;
  model?: string;
  baseURL?: string;
  reasoning?: CodeFarmerConfig['reasoning'];
  approval?: CodeFarmerConfig['approval'];
  stream?: boolean;
  logLevel?: CodeFarmerConfig['logLevel'];
  verbose?: boolean;
}

export interface BaseRuntime {
  workspace: string;
  config: CodeFarmerConfig;
  sessions: SessionStore;
  transactions: TransactionStore;
  logger: Logger;
}

export interface AgentRuntime extends BaseRuntime {
  session?: SessionRecord;
  runner: AgentRunner;
}

export interface AgentRuntimeOptions {
  sessionId?: string;
  history?: boolean;
  approvalPrompt?: (request: ApprovalRequest) => boolean | Promise<boolean>;
  interactive?: boolean;
  toolHooks?: ToolLifecycleHooks;
}

function configOverrides(options: GlobalOptions): ConfigOverrides {
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
  };
}

export function resolveSessionConfig(
  baseConfig: CodeFarmerConfig,
  options: GlobalOptions,
  session: SessionRecord | undefined,
  resuming: boolean,
): CodeFarmerConfig {
  if (session === undefined || !resuming) return baseConfig;
  if (
    session.baseURL !== undefined &&
    options.baseURL !== undefined &&
    session.baseURL !== baseConfig.baseURL
  ) {
    throw new ConfigError(
      `会话 ${session.id} 绑定到 ${session.baseURL}；请新建会话后再切换 Base URL`,
    );
  }
  return {
    ...baseConfig,
    ...(options.model === undefined ? { model: session.model } : {}),
    ...(session.baseURL === undefined ? {} : { baseURL: session.baseURL }),
  };
}

export async function createBaseRuntime(options: GlobalOptions): Promise<BaseRuntime> {
  const workspace = await canonicalWorkspace(options.cwd ?? process.cwd());
  await access(workspace, constants.R_OK);
  const config = await loadConfig({ cwd: workspace, cli: configOverrides(options) });
  const apiKey = await resolveApiKey();
  const [sessions, transactions, logger] = await Promise.all([
    SessionStore.create(workspace),
    TransactionStore.create(workspace),
    createLogger({
      level: config.logLevel,
      terminal: options.verbose === true,
      ...(apiKey === undefined ? {} : { secrets: [apiKey] }),
    }),
  ]);
  logger.info(
    { workspace, model: config.model, approval: config.approval },
    'CodeFarmer runtime initialized',
  );
  return { workspace, config, sessions, transactions, logger };
}

export async function createAgentRuntime(
  options: GlobalOptions,
  agentOptions: AgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    throw new AuthenticationError(
      '缺少 OPENAI_API_KEY；请设置环境变量，或运行 codefarmer setup 保存密钥到本地凭据',
    );
  }
  const base = await createBaseRuntime(options);
  const history = agentOptions.history ?? true;
  const session =
    agentOptions.sessionId === undefined
      ? history
        ? await base.sessions.createSession('openai', base.config.model, base.config.baseURL)
        : undefined
      : await base.sessions.get(agentOptions.sessionId);
  const config = resolveSessionConfig(
    base.config,
    options,
    session,
    agentOptions.sessionId !== undefined,
  );
  const runtimeBase = config === base.config ? base : { ...base, config };
  if (session !== undefined && session.model !== config.model) {
    session.model = config.model;
    if (history) await runtimeBase.sessions.save(session);
  }
  if (session !== undefined && session.baseURL === undefined) {
    session.baseURL = config.baseURL;
    if (history) await runtimeBase.sessions.save(session);
  }
  const approval = new PolicyApprovalController(
    config.approval,
    agentOptions.approvalPrompt ?? promptForApproval,
    agentOptions.interactive ?? process.stdin.isTTY,
  );
  const tools = await createToolRegistry({
    workspace: runtimeBase.workspace,
    maxFileBytes: config.maxFileSizeBytes,
    maxOutputBytes: config.maxToolOutputBytes,
    commandTimeoutMs: config.commandTimeoutMs,
    ignoredPaths: config.ignoredPaths,
    ...(session === undefined ? {} : { sessionId: session.id }),
    approve: async (request) =>
      approval.request({
        kind: request.kind === 'file-mutation' ? 'patch' : 'command',
        title: request.title,
        detail: request.detail,
        ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
      }),
    onMutation: async (mutation) => runtimeBase.transactions.record(mutation),
  });
  const provider = new OpenAIProvider({
    apiKey,
    baseURL: config.baseURL,
    connectionModel: config.model,
  });
  const runner = new AgentRunner({
    provider,
    tools,
    config,
    workspace: runtimeBase.workspace,
    ...(agentOptions.toolHooks === undefined ? {} : { toolHooks: agentOptions.toolHooks }),
    ...(history ? { sessionStore: runtimeBase.sessions } : {}),
  });
  runtimeBase.logger.info(
    { sessionId: session?.id, history, provider: provider.name, baseURL: config.baseURL },
    'Agent runtime initialized',
  );
  return { ...runtimeBase, ...(session === undefined ? {} : { session }), runner };
}
