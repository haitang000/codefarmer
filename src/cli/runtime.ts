import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

import type { Logger } from 'pino';

import {
  PolicyApprovalController,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../core/approval.js';
import { AgentRunner } from '../core/agent.js';
import { SessionOrchestrator } from '../core/session-orchestrator.js';
import { PermissionStore } from '../core/permissions.js';
import type { AgentHooks } from '../core/hooks.js';
import { discoverSkills } from '../core/skills.js';
import { SessionStore } from '../core/session-store.js';
import { TransactionStore } from '../core/transaction-store.js';
import { resolveProviderApiKey } from '../infra/credentials.js';
import { AuthenticationError, ConfigError } from '../infra/errors.js';
import { loadConfig, providerDefaults, type ConfigOverrides } from '../infra/config.js';
import { createLogger } from '../infra/logger.js';
import { canonicalWorkspace } from '../infra/paths.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { isProviderId, providerPreset } from '../providers/catalog.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolLifecycleHooks } from '../tools/types.js';
import type {
  AgentProvider,
  CodeFarmerConfig,
  ProviderId,
  SessionRecord,
  SkillCatalog,
  ToolResult,
} from '../types.js';
import { promptForApproval } from './ui.js';

export interface GlobalOptions {
  cwd?: string;
  provider?: ProviderId;
  model?: string;
  baseURL?: string;
  reasoning?: CodeFarmerConfig['reasoning'];
  verbosity?: CodeFarmerConfig['verbosity'];
  reasoningSummary?: CodeFarmerConfig['reasoningSummary'];
  approval?: CodeFarmerConfig['approval'];
  language?: CodeFarmerConfig['language'];
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
  skills?: SkillCatalog;
}

export interface AgentRuntime extends BaseRuntime {
  session?: SessionRecord;
  runner: AgentRunner;
  orchestrator?: SessionOrchestrator;
  permissions?: PermissionStore;
}

export interface AgentRuntimeOptions {
  sessionId?: string;
  history?: boolean;
  approvalPrompt?: (request: ApprovalRequest) => boolean | Promise<boolean>;
  approvalDecisionPrompt?: (
    request: ApprovalRequest,
  ) => ApprovalDecision | Promise<ApprovalDecision>;
  interactive?: boolean;
  toolHooks?: ToolLifecycleHooks;
  hooks?: AgentHooks;
}

function configOverrides(options: GlobalOptions): ConfigOverrides {
  const providerConfig =
    options.provider === undefined ? {} : providerDefaults(options.provider);
  return {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? providerConfig : { model: options.model }),
    ...(options.baseURL === undefined ? providerConfig : { baseURL: options.baseURL }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.verbosity === undefined ? {} : { verbosity: options.verbosity }),
    ...(options.reasoningSummary === undefined
      ? {}
      : { reasoningSummary: options.reasoningSummary }),
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    ...(options.language === undefined ? {} : { language: options.language }),
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
  if (!isProviderId(session.provider)) {
    throw new ConfigError(`会话 ${session.id} 使用不受支持的 Provider: ${session.provider}`);
  }
  if (options.provider !== undefined && options.provider !== session.provider) {
    throw new ConfigError(
      `会话 ${session.id} 绑定到 ${session.provider}；请新建会话后再切换 Provider`,
    );
  }
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
    provider: session.provider,
    ...(options.model === undefined ? { model: session.model } : {}),
    ...(session.baseURL === undefined ? {} : { baseURL: session.baseURL }),
    // 恢复该会话运行时的思考强度（对话设置的 effort 随会话继承），
    // 显式 CLI 参数优先，与 model 的恢复规则一致。
    ...(session.reasoning === undefined || options.reasoning !== undefined
      ? {}
      : { reasoning: session.reasoning }),
  };
}

export async function createBaseRuntime(options: GlobalOptions): Promise<BaseRuntime> {
  const workspace = await canonicalWorkspace(options.cwd ?? process.cwd());
  await access(workspace, constants.R_OK);
  const config = await loadConfig({ cwd: workspace, cli: configOverrides(options) });
  const skills = await discoverSkills(workspace);
  const apiKey = await resolveProviderApiKey(config.provider);
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
    { workspace, provider: config.provider, model: config.model, approval: config.approval },
    'CodeFarmer runtime initialized',
  );
  return { workspace, config, sessions, transactions, logger, skills };
}

export async function createAgentRuntime(
  options: GlobalOptions,
  agentOptions: AgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const base = await createBaseRuntime(options);
  const history = agentOptions.history ?? true;
  const session =
    agentOptions.sessionId === undefined
      ? history
        ? await base.sessions.createSession(base.config.provider, base.config.model, base.config.baseURL)
        : undefined
      : await base.sessions.get(agentOptions.sessionId);
  const config = resolveSessionConfig(
    base.config,
    options,
    session,
    agentOptions.sessionId !== undefined,
  );
  const apiKey = await resolveProviderApiKey(config.provider);
  if (!apiKey) {
    throw new AuthenticationError(
      `缺少 ${config.provider} 的 API Key（${providerPreset(config.provider).environmentVariables[0] ?? '对应环境变量'}）；请设置对应环境变量，或运行 codefarmer setup 保存密钥到本地凭据`,
    );
  }
  const runtimeBase = config === base.config ? base : { ...base, config };
  if (session !== undefined && session.model !== config.model) {
    session.model = config.model;
    if (history) await runtimeBase.sessions.save(session);
  }
  if (session !== undefined && session.baseURL === undefined) {
    session.baseURL = config.baseURL;
    if (history) await runtimeBase.sessions.save(session);
  }
  const permissions = await PermissionStore.create(runtimeBase.workspace);
  const approval = new PolicyApprovalController(
    config.approval,
    agentOptions.approvalDecisionPrompt ?? agentOptions.approvalPrompt ?? promptForApproval,
    agentOptions.interactive ?? process.stdin.isTTY,
  );
  const tools = await createToolRegistry({
    workspace: runtimeBase.workspace,
    maxFileBytes: config.maxFileSizeBytes,
    maxOutputBytes: config.maxToolOutputBytes,
    commandTimeoutMs: config.commandTimeoutMs,
    ignoredPaths: config.ignoredPaths,
    ...(runtimeBase.skills === undefined ? {} : { skillCatalog: runtimeBase.skills }),
    ...(session === undefined ? {} : { sessionId: session.id }),
    approve: async (request) => {
      const approvalRequest: ApprovalRequest = {
        kind: request.kind === 'file-mutation' ? 'patch' : 'command',
        title: request.title,
        detail: request.detail,
        ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
        ...(request.requireConfirmation === undefined
          ? {}
          : { requireConfirmation: request.requireConfirmation }),
      };
      if (permissions.has(approvalRequest) && request.requireConfirmation !== true) return true;
      const decision: ApprovalDecision = await approval.decide(approvalRequest);
      return permissions.apply(approvalRequest, decision);
    },
    onMutation: async (mutation) => runtimeBase.transactions.record(mutation),
  });
  const provider: AgentProvider =
    config.provider === 'openai'
      ? new OpenAIProvider({ apiKey, baseURL: config.baseURL, connectionModel: config.model })
      : new OpenAICompatibleProvider({
          provider: config.provider,
          apiKey,
          baseURL: config.baseURL,
      });
  const baseToolHooks = agentOptions.toolHooks;
  const hooks = agentOptions.hooks;
  const toolHooks: ToolLifecycleHooks | undefined =
    hooks === undefined && baseToolHooks === undefined
      ? undefined
      : {
          beforeTool: async (call: ToolCall) => {
            await hooks?.beforeTool?.({
              turnId: session?.id ?? 'tool',
              prompt: '',
              workspace: runtimeBase.workspace,
              ...(session?.id === undefined ? {} : { sessionId: session.id }),
              call: {
                callId: call.callId,
                name: call.name,
                arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
              },
            });
          },
          afterTool: async (call: ToolCall, result: ToolResult) => {
            try {
              await hooks?.afterTool?.(
                {
                  turnId: session?.id ?? 'tool',
                  prompt: '',
                  workspace: runtimeBase.workspace,
                  ...(session?.id === undefined ? {} : { sessionId: session.id }),
                  call: {
                    callId: call.callId,
                    name: call.name,
                    arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
                  },
                },
                result,
              );
            } catch {
              // Post-tool integrations are observers.
            }
          },
          ...(baseToolHooks?.onToolStart === undefined
            ? {}
            : { onToolStart: baseToolHooks.onToolStart }),
          ...(baseToolHooks?.onToolResult === undefined
            ? {}
            : { onToolResult: baseToolHooks.onToolResult }),
          ...(baseToolHooks?.onApprovalRequest === undefined
            ? {}
            : { onApprovalRequest: baseToolHooks.onApprovalRequest }),
          ...(baseToolHooks?.onApprovalResolution === undefined
            ? {}
            : { onApprovalResolution: baseToolHooks.onApprovalResolution }),
        };
  const runner = new AgentRunner({
    provider,
    tools,
    config,
    workspace: runtimeBase.workspace,
    ...(runtimeBase.skills === undefined ? {} : { skillCatalog: runtimeBase.skills }),
    ...(toolHooks === undefined ? {} : { toolHooks }),
    ...(history ? { sessionStore: runtimeBase.sessions } : {}),
  });
  const orchestrator = new SessionOrchestrator(runner, {
    workspace: runtimeBase.workspace,
    ...(session === undefined ? {} : { session, sessionId: session.id }),
    ...(agentOptions.hooks === undefined ? {} : { hooks: agentOptions.hooks }),
  });
  runtimeBase.logger.info(
    { sessionId: session?.id, history, provider: provider.name, baseURL: config.baseURL },
    'Agent runtime initialized',
  );
  return { ...runtimeBase, ...(session === undefined ? {} : { session }), runner, orchestrator, permissions };
}
