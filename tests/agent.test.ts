import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentRunner, extractToolTarget, trimOutputSemantic } from '../src/core/agent.js';
import { SessionStore } from '../src/core/session-store.js';
import { DEFAULT_CONFIG } from '../src/infra/config.js';
import { ProviderError } from '../src/infra/errors.js';
import { ScriptedProvider } from '../src/providers/fake.js';
import { createToolRegistry } from '../src/tools/registry.js';
import type {
  CodeFarmerConfig,
  ProviderEvent,
  ProviderRequest,
  SessionMessage,
  SessionRecord,
} from '../src/types.js';

const temporaryDirectories: string[] = [];

class RecordingScriptedProvider extends ScriptedProvider {
  readonly requests: ProviderRequest[] = [];

  override async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    yield* super.stream(request);
  }
}

class DeepSeekRecordingProvider extends RecordingScriptedProvider {
  override readonly name = 'deepseek';
  readonly supportsResponseContinuation = false;
}

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-agent-'));
  temporaryDirectories.push(directory);
  return directory;
}

function config(overrides: Partial<CodeFarmerConfig> = {}): CodeFarmerConfig {
  return {
    ...DEFAULT_CONFIG,
    ignoredPaths: [...DEFAULT_CONFIG.ignoredPaths],
    ...overrides,
  };
}

function sessionRecord(messageCount: number): SessionRecord {
  const messages: SessionMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const role: SessionMessage['role'] = index % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      id: `msg-${role}-${String(index)}`,
      role,
      content: `${role} turn ${String(index)}`,
      createdAt: new Date(1 + index).toISOString(),
    });
  }
  return {
    version: 1,
    id: 'session-compact-agent',
    workspace: '/workspace',
    provider: 'fake',
    model: 'test-model',
    status: 'active',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    previousResponseId: 'response-old',
    messages,
    toolCalls: [],
  };
}

async function runner(
  workspace: string,
  provider: ScriptedProvider,
  overrides: Partial<CodeFarmerConfig> = {},
  sessionStore?: SessionStore,
): Promise<AgentRunner> {
  const effectiveConfig = config(overrides);
  const tools = await createToolRegistry({
    workspace,
    maxFileBytes: effectiveConfig.maxFileSizeBytes,
    maxOutputBytes: effectiveConfig.maxToolOutputBytes,
    commandTimeoutMs: effectiveConfig.commandTimeoutMs,
  });
  return new AgentRunner({
    provider,
    tools,
    config: effectiveConfig,
    workspace,
    ...(sessionStore === undefined ? {} : { sessionStore }),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('AgentRunner', () => {
  it('generates and persists a model-based title after the first turn', async () => {
    const workspace = await temporaryWorkspace();
    const sessionStore = await SessionStore.create(workspace, {
      data: path.join(workspace, 'data'),
      config: path.join(workspace, 'config'),
      cache: path.join(workspace, 'cache'),
      log: path.join(workspace, 'log'),
      temp: path.join(workspace, 'temp'),
      userConfigFile: path.join(workspace, 'config.json'),
      setupStateFile: path.join(workspace, 'setup-state.json'),
      sessions: path.join(workspace, 'sessions'),
      transactions: path.join(workspace, 'transactions'),
    });
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: '已完成登录流程修复。' },
        {
          type: 'response_completed',
          responseId: 'response-main',
          outputText: '已完成登录流程修复。',
        },
      ],
      [
        { type: 'text_delta', delta: '修复登录流程' },
        { type: 'response_completed', responseId: 'response-title', outputText: '修复登录流程' },
      ],
    ]);
    const agent = await runner(workspace, provider, {}, sessionStore);

    const result = await agent.run('请修复登录流程并补充测试');
    const persisted = await sessionStore.get(result.sessionId);

    expect(persisted.title).toBe('修复登录流程');
    expect(persisted.titleSource).toBe('automatic');
    expect(persisted.titleGenerated).toBe(true);
    expect(provider.requests[1]?.tools).toBeUndefined();
    expect(provider.requests[1]?.input).toEqual([
      expect.objectContaining({ content: '请修复登录流程并补充测试' }),
      expect.objectContaining({ content: '已完成登录流程修复。' }),
    ]);
  });

  it('completes a text-only response and aggregates usage', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'Hello' },
        { type: 'text_delta', delta: ' from CodeFarmer' },
        {
          type: 'usage',
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        },
        {
          type: 'response_completed',
          responseId: 'response-text',
          outputText: 'Hello from CodeFarmer',
        },
      ],
    ]);
    const agent = await runner(workspace, provider);

    const events: ProviderEvent[] = [];
    const result = await agent.run('Introduce yourself', {
      history: false,
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      status: 'completed',
      message: 'Hello from CodeFarmer',
      responseId: 'response-text',
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
    expect(events).toHaveLength(4);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      verbosity: 'low',
      reasoningSummary: 'none',
      input: 'Introduce yourself',
      store: true,
    });
    expect(provider.requests[0]?.tools).toHaveLength(16);
  });

  it('executes a tool call and continues with its call id and response id', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'alpha.txt'), 'alpha\n', 'utf8');
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-list',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
        { type: 'response_completed', responseId: 'response-tools-1' },
      ],
      [
        { type: 'text_delta', delta: 'Found alpha.txt.' },
        {
          type: 'response_completed',
          responseId: 'response-tools-2',
          outputText: 'Found alpha.txt.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('List the files', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Found alpha.txt.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call-list',
      name: 'list_files',
      arguments: { path: '.', maxDepth: 1 },
      result: { success: true, toolName: 'list_files' },
    });
    expect(result.toolCalls[0]?.result.output).toContain('alpha.txt');

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.previousResponseId).toBe('response-tools-1');
    const continuation = provider.requests[1]?.input;
    expect(Array.isArray(continuation)).toBe(true);
    if (!Array.isArray(continuation)) throw new Error('Expected tool-result continuation input');
    expect(continuation[0]).toMatchObject({
      type: 'function_call_output',
      callId: 'call-list',
    });
    if (continuation[0]?.type !== 'function_call_output') {
      throw new Error('Expected a function_call_output item');
    }
    const toolOutput = JSON.parse(continuation[0].output) as {
      success?: unknown;
      output?: unknown;
    };
    expect(toolOutput.success).toBe(true);
    expect(toolOutput.output).toEqual(expect.stringContaining('alpha.txt'));
  });

  it('persists assistant text that accompanies tool calls for resumed sessions', async () => {
    const workspace = await temporaryWorkspace();
    const sessionStore = await SessionStore.create(workspace, {
      data: path.join(workspace, 'data'),
      config: path.join(workspace, 'config'),
      cache: path.join(workspace, 'cache'),
      log: path.join(workspace, 'log'),
      temp: path.join(workspace, 'temp'),
      userConfigFile: path.join(workspace, 'config.json'),
      setupStateFile: path.join(workspace, 'setup-state.json'),
      sessions: path.join(workspace, 'sessions'),
      transactions: path.join(workspace, 'transactions'),
    });
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'I will inspect the workspace first.' },
        {
          type: 'tool_call',
          call: {
            callId: 'call-list',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
        {
          type: 'response_completed',
          responseId: 'response-tools-1',
          outputText: 'I will inspect the workspace first.',
        },
      ],
      [
        { type: 'text_delta', delta: 'The inspection is complete.' },
        {
          type: 'response_completed',
          responseId: 'response-tools-2',
          outputText: 'The inspection is complete.',
        },
      ],
      [
        { type: 'text_delta', delta: 'Inspect the workspace' },
        {
          type: 'response_completed',
          responseId: 'response-title',
          outputText: 'Inspect the workspace',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, {}, sessionStore);

    const result = await agent.run('Inspect the workspace');
    const persisted = await sessionStore.get(result.sessionId);

    // The text that accompanied the tool-call round is stored as its own
    // assistant message, so a resumed session shows the full agent output
    // instead of only the run's final message.
    expect(persisted.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Inspect the workspace'],
      ['assistant', 'I will inspect the workspace first.'],
      ['assistant', 'The inspection is complete.'],
    ]);
    expect(persisted.toolCalls).toHaveLength(1);
    expect(persisted.toolCalls[0]).toMatchObject({
      toolName: 'list_files',
      success: true,
      arguments: { path: '.', maxDepth: 1 },
    });
  });

  it('replays explicit history when the endpoint rejects stored-response continuation', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'alpha.txt'), 'alpha\n', 'utf8');
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-list',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1, maxResults: 100 }),
          },
        },
        { type: 'response_completed', responseId: 'response-tools-1' },
      ],
      [
        {
          type: 'error',
          error: {
            code: 'invalid_request_error',
            message: 'No tool call found for tool output with call_id call-list.',
            retryable: false,
          },
        },
      ],
      [
        { type: 'text_delta', delta: 'Recovered.' },
        { type: 'response_completed', responseId: 'response-explicit', outputText: 'Recovered.' },
      ],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('List the files', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Recovered.');
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]?.previousResponseId).toBe('response-tools-1');
    const retried = provider.requests[2];
    expect(retried?.previousResponseId).toBeUndefined();
    expect(Array.isArray(retried?.input)).toBe(true);
    if (!Array.isArray(retried?.input)) throw new Error('Expected explicit history input');
    expect(retried.input.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
    ]);
  });

  it('stops at the configured tool-turn limit and requests one tool-free summary', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-1', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-limit-1' },
      ],
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-2', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-limit-2' },
      ],
      [
        { type: 'text_delta', delta: 'Progress summary.' },
        {
          type: 'response_completed',
          responseId: 'response-limit-summary',
          outputText: 'Progress summary.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, { maxAgentTurns: 2 });

    const result = await agent.run('Keep calling tools', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Progress summary.');
    expect(result.responseId).toBe('response-limit-summary');
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]?.previousResponseId).toBe('response-limit-1');
    expect(provider.requests[2]?.previousResponseId).toBe('response-limit-2');
    expect(result.toolCalls).toHaveLength(2);
    expect(provider.requests[2]?.tools).toEqual([]);
    expect(provider.requests[2]?.input).toContainEqual({
      type: 'message',
      role: 'user',
      content: expect.stringContaining('已达到最大工具轮次 2') as string,
    });
  });

  it('extends DeepSeek tool rounds instead of interrupting at the soft checkpoint', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new DeepSeekRecordingProvider([
      [
        {
          type: 'tool_call',
          call: { callId: 'deepseek-1', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'deepseek-response-1' },
      ],
      [
        {
          type: 'tool_call',
          call: { callId: 'deepseek-2', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'deepseek-response-2' },
      ],
      [
        {
          type: 'tool_call',
          call: { callId: 'deepseek-3', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'deepseek-response-3' },
      ],
      [
        { type: 'text_delta', delta: 'DeepSeek finished.' },
        {
          type: 'response_completed',
          responseId: 'deepseek-final',
          outputText: 'DeepSeek finished.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, { maxAgentTurns: 2 });
    const events: ProviderEvent[] = [];

    const result = await agent.run('Keep working until the task is complete', {
      history: false,
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('DeepSeek finished.');
    expect(result.toolCalls).toHaveLength(3);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[2]?.tools).not.toEqual([]);
    expect(events).toContainEqual({
      type: 'text_delta',
      delta: '\n[DeepSeek tool budget extended from 2 to 4 rounds; continuing the task]\n',
    });
  });

  it('does not execute a tool call returned by the summary request', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-1', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-limit-1' },
      ],
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-2', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-limit-2' },
      ],
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-3', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-limit-3' },
      ],
      [
        { type: 'text_delta', delta: 'All done.' },
        { type: 'response_completed', responseId: 'response-done', outputText: 'All done.' },
      ],
    ]);
    const agent = await runner(workspace, provider, { maxAgentTurns: 2 });

    const result = await agent.run('Keep working', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toContain('已达到最大工具轮次 2');
    expect(result.toolCalls).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.tools).toEqual([]);
  });

  it('falls back to a tool-less summary after auto-continuation hits the cap', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-1', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-cap-1' },
      ],
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-2', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-cap-2' },
      ],
      [
        { type: 'text_delta', delta: 'Capped summary.' },
        {
          type: 'response_completed',
          responseId: 'response-cap-summary',
          outputText: 'Capped summary.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, { maxAgentTurns: 2 });

    const result = await agent.run('Keep calling tools', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Capped summary.');
    expect(result.toolCalls).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.tools).toEqual([]);
    expect(provider.requests[2]?.input).toContainEqual(
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: expect.stringContaining('已达到最大工具轮次 2') as string,
      }),
    );
  });

  it('reports a local summary when the cap summary turn produces no output', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-1', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-cap-1' },
      ],
      [
        {
          type: 'tool_call',
          call: { callId: 'missing-2', name: 'missing_tool', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-cap-2' },
      ],
      [],
    ]);
    const agent = await runner(workspace, provider, { maxAgentTurns: 2 });

    const result = await agent.run('Keep calling tools', { history: false });

    // The run must not be thrown away when the final summary call fails:
    // report what was actually executed instead.
    expect(result.status).toBe('completed');
    expect(result.message).toContain('已达到最大工具轮次 2');
    expect(result.message).toContain('2 次工具调用');
    expect(result.toolCalls).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
  });

  it('restricts plan mode to read-only tools and rejects mutating calls', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: { callId: 'call-patch', name: 'apply_patch', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-plan-1' },
      ],
      [
        { type: 'text_delta', delta: 'Plan ready.' },
        {
          type: 'response_completed',
          responseId: 'response-plan-2',
          outputText: 'Plan ready.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('Plan a refactor', { history: false, plan: true });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Plan ready.');
    const tools = provider.requests[0]?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.readOnly)).toBe(true);
    expect(provider.requests[0]?.instructions).toContain('Plan mode is ON');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.result).toMatchObject({
      success: false,
      error: { code: 'PLAN_MODE_FORBIDDEN' },
    });
    // 同一次 run 的后续轮次仍处于计划模式。
    expect(provider.requests[1]?.tools?.every((tool) => tool.readOnly)).toBe(true);
  });

  it('keeps the full tool set available outside plan mode', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'response_completed', responseId: 'response-normal', outputText: 'ok' },
      ],
    ]);
    const agent = await runner(workspace, provider);

    await agent.run('Do something', { history: false });

    expect(provider.requests[0]?.tools).toHaveLength(16);
    expect(provider.requests[0]?.instructions).not.toContain('Plan mode is ON');
  });

  it('surfaces non-retryable provider error events without attempting another turn', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'error',
          error: { code: 'UPSTREAM_FAILURE', message: 'provider broke', retryable: false },
        },
      ],
    ]);
    const agent = await runner(workspace, provider);

    await expect(agent.run('Fail cleanly', { history: false })).rejects.toMatchObject({
      name: ProviderError.name,
      code: 'PROVIDER_ERROR',
      message: 'provider broke',
      retryable: false,
    });
    expect(provider.requests).toHaveLength(1);
  });

  it('retries the same turn when the provider failure is retryable', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'error',
          error: { code: 'UPSTREAM_FAILURE', message: 'gateway hiccup', retryable: true },
        },
      ],
      [
        { type: 'text_delta', delta: 'Recovered after retry.' },
        {
          type: 'response_completed',
          responseId: 'response-retry',
          outputText: 'Recovered after retry.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('Survive a hiccup', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Recovered after retry.');
    expect(provider.requests).toHaveLength(2);
  });

  it('recovers when a later attempt returns content after empty responses', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [{ type: 'response_completed', responseId: 'response-empty-1' }],
      [
        { type: 'text_delta', delta: 'Back online.' },
        { type: 'response_completed', responseId: 'response-empty-2', outputText: 'Back online.' },
      ],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('Say something', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Back online.');
    expect(provider.requests).toHaveLength(2);
  });

  it('fails with a clear reason after consecutive empty responses', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [{ type: 'response_completed', responseId: 'response-empty-1' }],
      [{ type: 'response_completed', responseId: 'response-empty-2' }],
      [{ type: 'response_completed', responseId: 'response-empty-3' }],
    ]);
    const agent = await runner(workspace, provider);

    await expect(agent.run('Say something', { history: false })).rejects.toMatchObject({
      name: ProviderError.name,
      code: 'PROVIDER_ERROR',
      retryable: true,
    });
    expect(provider.requests.length).toBe(3);
  });

  it('does not retry a truncated response that contains no answer or tool call', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'response_completed',
          responseId: 'response-length',
          finishReason: 'length',
        },
      ],
    ]);
    const agent = await runner(workspace, provider);

    await expect(agent.run('Say something', { history: false })).rejects.toMatchObject({
      name: ProviderError.name,
      code: 'PROVIDER_ERROR',
      retryable: false,
    });
    expect(provider.requests).toHaveLength(1);
  });

  it('does not retry DeepSeek v4 after a length stop without answer text', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'response_completed',
          responseId: 'response-deepseek-length',
          finishReason: 'length',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, {
      model: 'deepseek-v4-flash',
    });

    await expect(agent.run('完成任务', { history: false })).rejects.toMatchObject({
      name: ProviderError.name,
      code: 'PROVIDER_ERROR',
      retryable: false,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      reasoning: 'high',
      verbosity: 'low',
      reasoningSummary: 'none',
    });
    expect(provider.requests[0]?.maxOutputTokens).toBeUndefined();
  });

  it('completes when the stream ends without a response.completed event', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [{ type: 'text_delta', delta: 'Done without a completion event.' }],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('Finish silently', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Done without a completion event.');
    expect(result.responseId).toBeUndefined();
    expect(provider.requests).toHaveLength(1);
  });

  it('keeps running tool calls when the stream ends without a completion event', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'alpha.txt'), 'alpha\n', 'utf8');
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-list',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
      ],
      [{ type: 'text_delta', delta: 'Listed.' }],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('List the files', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Listed.');
    expect(result.toolCalls).toHaveLength(1);
    // The second turn must replay explicit history instead of chaining.
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.previousResponseId).toBeUndefined();
    expect(Array.isArray(provider.requests[1]?.input)).toBe(true);
  });

  it('falls back to explicit history when a chained turn fails with an unmatched error', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'alpha.txt'), 'alpha\n', 'utf8');
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-list',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
        { type: 'response_completed', responseId: 'response-chain-1' },
      ],
      [
        {
          type: 'error',
          error: {
            code: 'MYSTERY_FAILURE',
            message: 'gateway replied with something unexpected',
            retryable: false,
          },
        },
      ],
      [{ type: 'text_delta', delta: 'Recovered via explicit history.' }],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('List the files', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Recovered via explicit history.');
    expect(result.toolCalls).toHaveLength(1);
    // The failed chained turn must degrade to explicit history, not abort.
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.previousResponseId).toBeUndefined();
    expect(Array.isArray(provider.requests[2]?.input)).toBe(true);
  });

  it('keeps stored-response chaining off after degrading to explicit history', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'alpha.txt'), 'alpha\n', 'utf8');
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-list',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
        { type: 'response_completed', responseId: 'response-chain-1' },
      ],
      [
        {
          type: 'error',
          error: {
            code: 'invalid_request_error',
            message: 'No tool call found for tool output with call_id call-list.',
            retryable: false,
          },
        },
      ],
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-relist',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
        { type: 'response_completed', responseId: 'response-chain-2' },
      ],
      [
        { type: 'text_delta', delta: 'Recovered.' },
        { type: 'response_completed', responseId: 'response-chain-3', outputText: 'Recovered.' },
      ],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('List the files twice', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Recovered.');
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[2]?.previousResponseId).toBeUndefined();
    // The chain broke once, so later turns must not re-arm previousResponseId
    // even though the gateway returned fresh response ids.
    expect(provider.requests[3]?.previousResponseId).toBeUndefined();
    expect(Array.isArray(provider.requests[3]?.input)).toBe(true);
  });

  it('keeps the turn limit after degrading to explicit history', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'alpha.txt'), 'alpha\n', 'utf8');
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-list',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
        { type: 'response_completed', responseId: 'response-chain-1' },
      ],
      [
        {
          type: 'error',
          error: {
            code: 'invalid_request_error',
            message: 'No tool call found for tool output with call_id call-list.',
            retryable: false,
          },
        },
      ],
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-relist',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
        { type: 'response_completed', responseId: 'response-chain-2' },
      ],
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-again',
            name: 'list_files',
            arguments: JSON.stringify({ path: '.', maxDepth: 1 }),
          },
        },
        { type: 'response_completed', responseId: 'response-chain-3' },
      ],
      [
        { type: 'text_delta', delta: 'Recovered.' },
        { type: 'response_completed', responseId: 'response-chain-4', outputText: 'Recovered.' },
      ],
    ]);
    const agent = await runner(workspace, provider, { maxAgentTurns: 2 });

    const result = await agent.run('List the files twice', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toContain('已达到最大工具轮次 2');
    expect(result.toolCalls).toHaveLength(2);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3]?.tools).toEqual([]);
  });

  it('trims whole parallel tool batches without orphaning call outputs', async () => {
    const workspace = await temporaryWorkspace();
    // Big enough that three rounds of parallel reads overflow the replay
    // transcript budget and force trimming.
    await writeFile(path.join(workspace, 'big.txt'), 'x'.repeat(150_000), 'utf8');
    const readCalls = (round: number): ProviderEvent[] => [
      {
        type: 'tool_call',
        call: {
          callId: `call-read-${String(round)}-a`,
          name: 'read_file',
          arguments: JSON.stringify({ path: 'big.txt', startLine: null, endLine: null }),
        },
      },
      {
        type: 'tool_call',
        call: {
          callId: `call-read-${String(round)}-b`,
          name: 'read_file',
          arguments: JSON.stringify({ path: 'big.txt', startLine: null, endLine: null }),
        },
      },
    ];
    const provider = new RecordingScriptedProvider([
      readCalls(1),
      readCalls(2),
      readCalls(3),
      [{ type: 'text_delta', delta: 'Finished reading.' }],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('Read the big file repeatedly', { history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Finished reading.');
    expect(provider.requests).toHaveLength(4);
    const finalInput = provider.requests[3]?.input;
    expect(Array.isArray(finalInput)).toBe(true);
    if (!Array.isArray(finalInput)) throw new Error('Expected explicit history input');
    // Every surviving output must still have its call earlier in the replay;
    // trimming a partial batch orphans outputs and gateways answer with
    // "400 No tool call found for tool output".
    const visibleCallIds = new Set<string>();
    let outputCount = 0;
    for (const item of finalInput) {
      if (item.type === 'function_call') visibleCallIds.add(item.callId);
      if (item.type === 'function_call_output') {
        outputCount += 1;
        expect(visibleCallIds.has(item.callId)).toBe(true);
      }
    }
    // Parallel output is clamped proportionally before it enters the next turn.
    expect(outputCount).toBe(6);
    const outputs = finalInput.filter((item) => item.type === 'function_call_output');
    expect(outputs.every((item) => item.output.length <= 12_500)).toBe(true);
  });

  it('compacts a session and replays the summary as explicit history on the next run', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'Early context summary.' },
        {
          type: 'response_completed',
          responseId: 'response-compact',
          outputText: 'Early context summary.',
        },
        { type: 'usage', usage: { inputTokens: 50, outputTokens: 3, totalTokens: 53 } },
      ],
      [
        { type: 'text_delta', delta: 'Next turn answer.' },
        {
          type: 'response_completed',
          responseId: 'response-next',
          outputText: 'Next turn answer.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider);
    const record = sessionRecord(20);

    const result = await agent.compact(record);

    expect(result.summary).toBe('Early context summary.');
    expect(result.compressedMessageCount).toBeGreaterThan(0);
    expect(record.previousResponseId).toBeUndefined();
    expect(record.messages[0]).toMatchObject({ role: 'system', compressed: true });
    expect(record.compactedAt).toBeDefined();

    const runResult = await agent.run('Continue the work', { session: record });

    expect(runResult.status).toBe('completed');
    expect(runResult.message).toBe('Next turn answer.');
    expect(provider.requests).toHaveLength(2);
    const second = provider.requests[1];
    expect(second?.previousResponseId).toBeUndefined();
    expect(Array.isArray(second?.input)).toBe(true);
    if (!Array.isArray(second?.input)) throw new Error('Expected explicit history input');
    expect(second.input[0]).toMatchObject({
      type: 'message',
      role: 'system',
      content: expect.stringContaining('Early context summary.') as string,
    });
    // The newest turn is appended after the replayed summary.
    expect(second.input[second.input.length - 1]).toMatchObject({
      type: 'message',
      role: 'user',
      content: 'Continue the work',
    });
  });

  it('automatically compacts a long session before the next turn when autoCompact is enabled', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'Auto summary.' },
        {
          type: 'response_completed',
          responseId: 'response-auto',
          outputText: 'Auto summary.',
        },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      ],
      [
        { type: 'text_delta', delta: 'After auto-compact.' },
        {
          type: 'response_completed',
          responseId: 'response-after',
          outputText: 'After auto-compact.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, { autoCompact: true });
    const record = sessionRecord(50);
    const events: ProviderEvent[] = [];

    const result = await agent.run('Continue', {
      session: record,
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('After auto-compact.');
    // The early messages were folded into a stored summary before the turn.
    expect(record.messages[0]).toMatchObject({ role: 'system', compressed: true });
    expect(record.messages.some((message) => message.content === 'Continue')).toBe(true);
    expect(events.some((event) => event.type === 'compacted')).toBe(true);
    // One summarising request + one real turn.
    expect(provider.requests).toHaveLength(2);
  });

  it('skips auto-compaction when disabled even on a long session', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'Plain turn.' },
        {
          type: 'response_completed',
          responseId: 'response-plain',
          outputText: 'Plain turn.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, { autoCompact: false });
    const record = sessionRecord(50);

    const result = await agent.run('Continue', { session: record });

    expect(result.status).toBe('completed');
    expect(record.messages[0]).not.toMatchObject({ role: 'system', compressed: true });
    expect(provider.requests).toHaveLength(1);
  });

  it('refuses a turn once the session cost reaches the configured budget', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'Should never run.' },
        {
          type: 'response_completed',
          responseId: 'response-never',
          outputText: 'Should never run.',
        },
      ],
    ]);
    // gpt-5.6-sol input is $5/1M tokens; 2M tokens already cost $10.
    const agent = await runner(workspace, provider, {
      budgetUsd: 0.5,
      model: 'gpt-5.6-sol',
    });
    const record = sessionRecord(1);
    record.usage = { inputTokens: 2_000_000, outputTokens: 0, totalTokens: 2_000_000 };

    const result = await agent.run('Do more work', { session: record, history: false });

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(result.error?.message).toContain('$10.00');
    // No provider request was made and no message was appended.
    expect(provider.requests).toHaveLength(0);
    expect(record.messages).toHaveLength(1);
  });

  it('runs normally when the session cost is below the budget', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'Under budget.' },
        {
          type: 'response_completed',
          responseId: 'response-budget-ok',
          outputText: 'Under budget.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, {
      budgetUsd: 0.5,
      model: 'gpt-5.6-sol',
    });
    const record = sessionRecord(1);
    record.usage = { inputTokens: 100, outputTokens: 100, totalTokens: 200 };

    const result = await agent.run('Do a cheap turn', { session: record, history: false });

    expect(result.status).toBe('completed');
    expect(result.message).toBe('Under budget.');
    expect(provider.requests).toHaveLength(1);
  });

  it('does not enforce the budget for models without a known list price', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        { type: 'text_delta', delta: 'Unknown price, no gate.' },
        {
          type: 'response_completed',
          responseId: 'response-unknown',
          outputText: 'Unknown price, no gate.',
        },
      ],
    ]);
    const agent = await runner(workspace, provider, {
      budgetUsd: 0.000001,
      model: 'my-unknown-model',
    });
    const record = sessionRecord(1);
    record.usage = { inputTokens: 50_000_000, outputTokens: 0, totalTokens: 50_000_000 };

    const result = await agent.run('Expensive unknown model', {
      session: record,
      history: false,
    });

    expect(result.status).toBe('completed');
  });

  it('semantically trims long output while preserving error and diagnostic lines', () => {
    const rawOutput = [
      'Line 1: starting build process',
      'Line 2: loading configuration',
      'Line 3: resolving dependencies',
      'Line 4: verbose log chunk 1',
      'Line 5: verbose log chunk 2',
      'Line 6: verbose log chunk 3',
      'Line 7: verbose log chunk 4',
      'Line 8: verbose log chunk 5',
      'Line 9: error: TS2304 cannot find name Foo',
      'Line 10: verbose log chunk 6',
      'Line 11: verbose log chunk 7',
      'Line 12: verbose log chunk 8',
      'Line 13: build failed with 1 error',
      'Line 14: exit code 1',
    ].join('\n');

    const trimmed = trimOutputSemantic(rawOutput, 260);
    expect(trimmed.length).toBeLessThanOrEqual(260);
    expect(trimmed).toContain('error: TS2304 cannot find name Foo');
    expect(trimmed).toContain('starting build process');
    expect(trimmed).toContain('exit code 1');
  });

  it('identifies run_command targets from the args array', () => {
    expect(
      extractToolTarget('run_command', { executable: 'git', args: ['status', '--short'] }),
    ).toBe('git status --short');
    expect(
      extractToolTarget('run_command', {
        executable: 'pnpm',
        arguments: ['test', 'file-tools'],
      }),
    ).toBe('pnpm test file-tools');
    expect(extractToolTarget('read_file', { path: 'src/cli.ts' })).toBe('src/cli.ts');
  });

  it('injects self-correction advice after consecutive tool failures on the same target', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new RecordingScriptedProvider([
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-patch-1',
            name: 'apply_patch',
            arguments: JSON.stringify({
              path: 'nonexistent.txt',
              patch: '@@ -1,1 +1,1 @@\n-old\n+new\n',
              expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
            }),
          },
        },
        { type: 'response_completed', responseId: 'resp-1' },
      ],
      [
        {
          type: 'tool_call',
          call: {
            callId: 'call-patch-2',
            name: 'apply_patch',
            arguments: JSON.stringify({
              path: 'nonexistent.txt',
              patch: '@@ -1,1 +1,1 @@\n-old\n+new\n',
              expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
            }),
          },
        },
        { type: 'response_completed', responseId: 'resp-2' },
      ],
      [
        { type: 'text_delta', delta: 'Recovered.' },
        { type: 'response_completed', responseId: 'resp-3', outputText: 'Recovered.' },
      ],
    ]);
    const agent = await runner(workspace, provider);

    const result = await agent.run('Fix nonexistent file', { history: false });
    expect(result.status).toBe('completed');
    expect(provider.requests).toHaveLength(3);

    const lastRequest = provider.requests[2];
    const input = lastRequest?.input;
    expect(Array.isArray(input)).toBe(true);
    if (Array.isArray(input)) {
      const lastOutputItem = input[input.length - 1];
      expect(lastOutputItem?.type).toBe('function_call_output');
      if (lastOutputItem?.type === 'function_call_output') {
        expect(lastOutputItem.output).toContain('Self-Correction Advice');
        expect(lastOutputItem.output).toContain('apply_patch has failed repeatedly');
      }
    }
  });
});
