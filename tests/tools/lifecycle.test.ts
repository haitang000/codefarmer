import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentRunner } from '../../src/core/agent.js';
import { DEFAULT_CONFIG } from '../../src/infra/config.js';
import { ScriptedProvider } from '../../src/providers/fake.js';
import { createToolRegistry, ToolRegistry } from '../../src/tools/registry.js';
import type {
  ToolCall,
  ToolDefinition,
  ToolLifecycleHooks,
  ToolResult,
} from '../../src/tools/types.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-lifecycle-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const probeDefinition: ToolDefinition = {
  name: 'probe',
  description: 'Test probe',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  readOnly: true,
};

describe('tool lifecycle hooks', () => {
  it('forwards a per-run signal and emits tool start/result notifications', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let receivedSignal: AbortSignal | undefined;
    const hooks: ToolLifecycleHooks = {
      onToolStart: (call) => {
        events.push(`start:${call.callId}`);
      },
      onToolResult: (call, result) => {
        events.push(`result:${call.callId}:${String(result.success)}`);
      },
    };
    const registry = new ToolRegistry(
      [
        {
          definition: probeDefinition,
          execute: (arguments_, callId, options): Promise<ToolResult> => {
            expect(arguments_).toEqual({});
            receivedSignal = options?.signal;
            return Promise.resolve({ callId, toolName: 'probe', success: true, output: 'ok' });
          },
        },
      ],
      { hooks },
    );

    const call: ToolCall = { callId: 'probe-1', name: 'probe', arguments: {} };
    const result = await registry.executeMany([call], { signal: controller.signal });

    expect(result[0]?.result).toMatchObject({ success: true, output: 'ok' });
    expect(receivedSignal).toBe(controller.signal);
    expect(events).toEqual(['start:probe-1', 'result:probe-1:true']);
  });

  it('runs read-only groups in parallel and keeps mutating calls in order', async () => {
    const events: string[] = [];
    let activeReaders = 0;
    let maxReaders = 0;
    const readerDefinition: ToolDefinition = {
      name: 'reader',
      description: 'Read probe',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      readOnly: true,
    };
    const writerDefinition: ToolDefinition = {
      ...readerDefinition,
      name: 'writer',
      description: 'Write probe',
      readOnly: false,
    };
    const registry = new ToolRegistry([
      {
        definition: readerDefinition,
        execute: async (_arguments, callId): Promise<ToolResult> => {
          activeReaders += 1;
          maxReaders = Math.max(maxReaders, activeReaders);
          events.push(`start:${callId}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeReaders -= 1;
          events.push(`end:${callId}`);
          return { callId, toolName: 'reader', success: true, output: 'ok' };
        },
      },
      {
        definition: writerDefinition,
        execute: async (_arguments, callId): Promise<ToolResult> => {
          events.push(`start:${callId}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push(`end:${callId}`);
          return { callId, toolName: 'writer', success: true, output: 'ok' };
        },
      },
    ]);

    const results = await registry.executeMany([
      { callId: 'r1', name: 'reader', arguments: {} },
      { callId: 'r2', name: 'reader', arguments: {} },
      { callId: 'w1', name: 'writer', arguments: {} },
      { callId: 'r3', name: 'reader', arguments: {} },
      { callId: 'w2', name: 'writer', arguments: {} },
    ]);

    expect(results.map((entry) => entry.callId)).toEqual(['r1', 'r2', 'w1', 'r3', 'w2']);
    expect(results.every((entry) => entry.result.success)).toBe(true);
    // r1 and r2 overlap; the mutating call gates the following group.
    expect(maxReaders).toBe(2);
    expect(events.indexOf('end:r1')).toBeLessThan(events.indexOf('start:w1'));
    expect(events.indexOf('end:r2')).toBeLessThan(events.indexOf('start:w1'));
    expect(events.indexOf('end:w1')).toBeLessThan(events.indexOf('start:r3'));
    expect(events.indexOf('end:r3')).toBeLessThan(events.indexOf('start:w2'));
  });

  it('passes run-level hooks and cancellation into AgentRunner tool execution', async () => {
    const workspace = await temporaryWorkspace();
    const controller = new AbortController();
    const events: string[] = [];
    let receivedSignal: AbortSignal | undefined;
    const registry = new ToolRegistry([
      {
        definition: probeDefinition,
        execute: (_arguments, callId, options): Promise<ToolResult> => {
          receivedSignal = options?.signal;
          return Promise.resolve({ callId, toolName: 'probe', success: true, output: 'ok' });
        },
      },
    ]);
    const provider = new ScriptedProvider([
      [
        {
          type: 'tool_call',
          call: { callId: 'probe-agent', name: 'probe', arguments: '{}' },
        },
        { type: 'response_completed', responseId: 'response-tools' },
      ],
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'response_completed', responseId: 'response-text', outputText: 'done' },
      ],
    ]);
    const runner = new AgentRunner({
      provider,
      tools: registry,
      workspace,
      config: { ...DEFAULT_CONFIG, ignoredPaths: [...DEFAULT_CONFIG.ignoredPaths] },
    });

    const result = await runner.run('Use the probe', {
      history: false,
      signal: controller.signal,
      toolHooks: {
        onToolStart: (call) => {
          events.push(`start:${call.callId}`);
        },
        onToolResult: (call, toolResult) => {
          events.push(`result:${call.callId}:${String(toolResult.success)}`);
        },
      },
    });

    expect(result).toMatchObject({ status: 'completed', message: 'done' });
    expect(receivedSignal).toBe(controller.signal);
    expect(events).toEqual(['start:probe-agent', 'result:probe-agent:true']);
  });

  it('emits approval request and resolution around a file mutation', async () => {
    const workspace = await temporaryWorkspace();
    const events: string[] = [];
    const approvals: string[] = [];
    const hooks: ToolLifecycleHooks = {
      onToolStart: (call) => {
        events.push(`start:${call.name}`);
      },
      onApprovalRequest: (request, call) => {
        events.push(`approval-request:${request.kind}:${call?.callId ?? 'unknown'}`);
      },
      onApprovalResolution: (request, approved, call) => {
        events.push(
          `approval-resolution:${request.kind}:${String(approved)}:${call?.callId ?? 'unknown'}`,
        );
      },
      onToolResult: (call, result) => {
        events.push(`result:${call.name}:${String(result.success)}`);
      },
    };
    const registry = await createToolRegistry({
      workspace,
      approve: (request) => {
        approvals.push(request.kind);
        return true;
      },
      hooks,
    });
    const patch = ['--- /dev/null', '+++ b/created.txt', '@@ -0,0 +1 @@', '+created', ''].join(
      '\n',
    );

    const result = await registry.execute({
      callId: 'patch-1',
      name: 'apply_patch',
      arguments: { path: 'created.txt', patch, expectedSha256: null },
    });

    expect(result.success).toBe(true);
    expect(approvals).toEqual(['file-mutation']);
    expect(events).toEqual([
      'start:apply_patch',
      'approval-request:file-mutation:patch-1',
      'approval-resolution:file-mutation:true:patch-1',
      'result:apply_patch:true',
    ]);
    expect(await readFile(path.join(workspace, 'created.txt'), 'utf8')).toBe('created\n');
  });
});
