import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolRegistry } from '../../src/tools/registry.js';
import { classifyCommand, sanitiseEnvironment } from '../../src/tools/run-command.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-command-'));
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

describe('run_command safety', () => {
  it('blocks shell evaluation, dangerous commands, and unsupported Git writes', () => {
    expect(classifyCommand('sh', ['-c', 'echo unsafe']).risk).toBe('blocked');
    expect(classifyCommand('cmd.exe', ['/c', 'echo unsafe']).risk).toBe('blocked');
    expect(classifyCommand('rm', ['file.txt']).risk).toBe('blocked');
    expect(classifyCommand('git', ['commit', '-m', 'message']).risk).toBe('blocked');
    expect(classifyCommand('git', ['push', 'origin', 'main'])).toMatchObject({
      risk: 'mutating',
      requireConfirmation: true,
    });
    expect(classifyCommand('git', ['status', '--short']).risk).toBe('mutating');
    expect(classifyCommand('cat', ['file.txt']).risk).toBe('mutating');
    expect(classifyCommand('node', ['--eval=console.log(1)']).risk).toBe('blocked');
    expect(classifyCommand('rg', ['--pre=tool', 'query']).risk).toBe('blocked');
    expect(classifyCommand('find', ['.', '-exec', 'tool', ';']).risk).toBe('blocked');
    expect(classifyCommand('find', ['.', '-delete']).risk).toBe('mutating');
    expect(classifyCommand('sed', ['-i.bak', 's/a/b/', 'file']).risk).toBe('mutating');
  });

  it('removes sensitive environment values', () => {
    const clean = sanitiseEnvironment({
      PATH: 'path-value',
      OPENAI_API_KEY: 'api-key',
      SERVICE_TOKEN: 'token',
      dbPassword: 'password',
      NORMAL_VALUE: 'visible',
    });
    expect(clean).toEqual({ PATH: 'path-value', NORMAL_VALUE: 'visible' });
  });

  it('runs direct read-only executables and rejects mutating commands before execution', async () => {
    const workspace = await temporaryWorkspace();
    const approve = vi.fn(() => false);
    const registry = await createToolRegistry({ workspace, approve });
    const version = await registry.execute({
      callId: 'version',
      name: 'run_command',
      arguments: { executable: process.execPath, args: ['--version'] },
    });
    expect(version.success).toBe(true);
    expect(version.output).toMatch(/v\d+/u);
    expect(approve).not.toHaveBeenCalled();

    const denied = await registry.execute({
      callId: 'denied',
      name: 'run_command',
      arguments: { executable: process.execPath, args: ['--input-type=module'] },
    });
    expect(denied).toMatchObject({ success: false, error: { code: 'APPROVAL_DENIED' } });
    expect(approve).toHaveBeenCalledOnce();
  });

  it('requires explicit confirmation before running git push', async () => {
    const workspace = await temporaryWorkspace();
    const approve = vi.fn(() => false);
    const registry = await createToolRegistry({ workspace, approve });

    const result = await registry.execute({
      callId: 'push',
      name: 'run_command',
      arguments: { executable: 'git', args: ['push', 'origin', 'main'] },
    });

    expect(result).toMatchObject({ success: false, error: { code: 'APPROVAL_DENIED' } });
    expect(approve).toHaveBeenCalledWith({
      kind: 'command',
      title: 'Push Git changes',
      detail: '["git","push","origin","main"]',
      readOnly: false,
      requireConfirmation: true,
    });
  });

  it('parses stringified null optional arguments from gateways', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace, approve: () => false });
    // cwd and timeoutMs arrive as the literal text "null" from gateways that
    // stringify JSON null; the tool must fall back to defaults instead of
    // failing argument validation.
    const version = await registry.execute({
      callId: 'version-null',
      name: 'run_command',
      arguments: { executable: process.execPath, args: ['--version'], cwd: 'null', timeoutMs: 'null' },
    });
    expect(version.success).toBe(true);
    expect(version.output).toMatch(/v\d+/u);
  });

  it('does not reintroduce sensitive variables when spawning a child process', async () => {
    const workspace = await temporaryWorkspace();
    const script = path.join(workspace, 'read-env.cjs');
    await writeFile(script, "process.stdout.write(process.env.OPENAI_API_KEY ?? 'missing')\n");
    vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-child');
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const result = await registry.execute({
      callId: 'environment',
      name: 'run_command',
      arguments: { executable: process.execPath, args: [script] },
    });
    vi.unstubAllEnvs();
    expect(result.success).toBe(true);
    expect(result.output).toContain('missing');
    expect(result.output).not.toContain('must-not-reach-child');
  });
});
