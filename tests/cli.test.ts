import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const require = createRequire(import.meta.url);
const TSX_CLI = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
import type { SessionStore } from '../src/core/session-store.js';
const temporaryDirectories: string[] = [];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== 'OPENAI_API_KEY' && !name.startsWith('CODEFARMER_'),
    ),
  );
  return {
    ...environment,
    NO_COLOR: '1',
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
  };
}

async function runCli(
  args: string[],
  cwd: string,
  environmentRoot: string = cwd,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
      cwd,
      env: isolatedEnvironment(environmentRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

/**
 * Point the platform user directories at a scratch root for the duration of a
 * callback, using the same layout as `isolatedEnvironment` so that session
 * files written here are visible to the spawned CLI process.
 */
async function withIsolatedEnv<T>(
  root: string,
  fn: (sessionStore: typeof SessionStore) => Promise<T>,
): Promise<T> {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      HOME: root,
      USERPROFILE: root,
      APPDATA: path.join(root, 'appdata'),
      LOCALAPPDATA: path.join(root, 'localappdata'),
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
      XDG_DATA_HOME: path.join(root, 'xdg-data'),
      XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
      XDG_STATE_HOME: path.join(root, 'xdg-state'),
    });
    // env-paths 在模块加载时缓存 os.homedir()（macOS/Windows 分支），
    // 必须重置模块缓存让 SessionStore 重新读取 stub 后的环境变量，
    // 否则测试进程内写入的 session 会落到真实用户目录，与 CLI 子进程不一致。
    vi.resetModules();
    const reloaded = await import('../src/core/session-store.js');
    return await fn(reloaded.SessionStore);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

/** Create a workspace Git repository with an `origin` bare remote and an
 * upstream branch, mirroring a freshly cloned project. */
async function repositoryWithUpstream(): Promise<{ workspace: string; remote: string }> {
  const root = await temporaryDirectory();
  const remote = path.join(root, 'remote.git');
  await execa('git', ['init', '--bare', '--quiet', remote], { cwd: root });
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  await execa('git', ['init', '--quiet'], { cwd: workspace });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
  await writeFile(path.join(workspace, 'file.txt'), 'hello\n');
  await execa('git', ['add', '.'], { cwd: workspace });
  await execa('git', ['commit', '-m', 'initial'], { cwd: workspace });
  const branch = (
    await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace })
  ).stdout.trim();
  await execa('git', ['remote', 'add', 'origin', remote], { cwd: workspace });
  await execa('git', ['push', '-u', 'origin', branch], { cwd: workspace });
  return { workspace, remote };
}

async function workspaceBranch(workspace: string): Promise<string> {
  return (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace })).stdout.trim();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('CodeFarmer CLI', () => {
  it('shows help and exits successfully when called without a command', async () => {
    const root = await temporaryDirectory();
    const result = await runCli([], root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: codefarmer');
  });

  it('prints top-level help without credentials or network access', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();

    const result = await runCli(['--help'], workspace, environmentRoot);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: codefarmer');
    expect(result.stdout).toContain('run');
    expect(result.stdout).toContain('doctor');
  });

  it('initializes a schema-linked project configuration', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();

    const result = await runCli(['--cwd', workspace, 'init'], workspace, environmentRoot);

    expect(result.code).toBe(0);
    const written = JSON.parse(
      await readFile(path.join(workspace, 'codefarmer.config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(written).toEqual({
      $schema: 'https://unpkg.com/codefarmer@0.1.0/schemas/codefarmer.config.schema.json',
      model: 'gpt-5.6-sol',
      baseURL: 'https://api.openai.com/v1',
      reasoning: 'auto',
      verbosity: 'low',
      reasoningSummary: 'none',
      approval: 'ask',
    });
  });

  it('sets and reads project configuration through subcommands', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();

    const setResult = await runCli(
      ['--cwd', workspace, 'config', 'set', 'model', 'test-model', '--project'],
      workspace,
      environmentRoot,
    );
    const getResult = await runCli(
      ['--cwd', workspace, 'config', 'get', 'model'],
      workspace,
      environmentRoot,
    );
    const listResult = await runCli(
      ['--cwd', workspace, 'config', 'list'],
      workspace,
      environmentRoot,
    );

    expect(setResult.code).toBe(0);
    expect(getResult.code).toBe(0);
    expect(JSON.parse(getResult.stdout)).toBe('test-model');
    expect(listResult.code).toBe(0);
    expect(JSON.parse(listResult.stdout)).toMatchObject({
      model: 'test-model',
      reasoning: 'auto',
      verbosity: 'low',
      reasoningSummary: 'none',
      approval: 'ask',
      maxAgentTurns: 25,
    });
  });

  it('accepts Base URL from project config and the global CLI override', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    const setResult = await runCli(
      ['--cwd', workspace, 'config', 'set', 'baseURL', 'https://gateway.example/v1/', '--project'],
      workspace,
      environmentRoot,
    );
    const getResult = await runCli(
      ['--cwd', workspace, 'config', 'get', 'baseURL'],
      workspace,
      environmentRoot,
    );
    const overrideResult = await runCli(
      [
        '--cwd',
        workspace,
        '--base-url',
        'http://localhost:8080/v1/',
        '--verbosity',
        'high',
        '--reasoning-summary',
        'concise',
        'config',
        'list',
      ],
      workspace,
      environmentRoot,
    );

    expect(setResult.code).toBe(0);
    expect(JSON.parse(getResult.stdout)).toBe('https://gateway.example/v1');
    expect(JSON.parse(overrideResult.stdout)).toMatchObject({
      baseURL: 'http://localhost:8080/v1',
      verbosity: 'high',
      reasoningSummary: 'concise',
    });
  });

  it('returns authentication exit code 4 before a run can call OpenAI', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();

    const result = await runCli(
      ['--cwd', workspace, 'run', '--json', 'Do not contact the network'],
      workspace,
      environmentRoot,
    );

    expect(result.code).toBe(4);
    const payload = JSON.parse(result.stdout) as {
      sessionId?: unknown;
      status?: unknown;
      message?: unknown;
      toolCalls?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    expect(payload).toMatchObject({
      sessionId: '',
      status: 'failed',
      message: '',
      toolCalls: [],
      error: {
        code: 'AUTHENTICATION_ERROR',
      },
    });
    expect(payload.error?.message).toEqual(expect.stringContaining('OPENAI_API_KEY'));
    expect(result.stderr).toBe('');
  });

  it('uses exit code 2 for invalid command-line usage', async () => {
    const root = await temporaryDirectory();
    const result = await runCli(['run'], root);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("missing required argument 'prompt'");
  });

  it('generates shell completion scripts for bash, zsh, and fish', async () => {
    const root = await temporaryDirectory();

    const bash = await runCli(['completions', 'bash'], root);
    const zsh = await runCli(['completions', 'zsh'], root);
    const fish = await runCli(['completions', 'fish'], root);

    expect(bash.code).toBe(0);
    expect(bash.stderr).toBe('');
    expect(bash.stdout).toContain('complete -F _codefarmer codefarmer');
    expect(bash.stdout).toContain("'sessions export'");
    expect(bash.stdout).toContain("'sessions compact'");
    expect(zsh.code).toBe(0);
    expect(zsh.stderr).toBe('');
    expect(zsh.stdout).toContain('#compdef codefarmer');
    expect(zsh.stdout).toContain("'sessions export:导出会话为 Markdown 或 JSON");
    expect(zsh.stdout).toContain("'sessions compact:压缩长会话");
    expect(fish.code).toBe(0);
    expect(fish.stderr).toBe('');
    expect(fish.stdout).toContain('complete -c codefarmer');
    expect(fish.stdout).toContain('completions');
  });

  it('rejects an unsupported completion shell with exit code 2', async () => {
    const root = await temporaryDirectory();
    const result = await runCli(['completions', 'powershell'], root);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('powershell');
  });

  it('refuses to run setup without an interactive terminal', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();

    const result = await runCli(['--cwd', workspace, 'setup'], workspace, environmentRoot);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('setup 需要交互式终端');
  });

  it('lists auto-titled sessions and renames them through subcommands', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    const sessionId = await withIsolatedEnv(environmentRoot, async (SessionStoreRef) => {
      const store = await SessionStoreRef.create(workspace);
      const session = await store.createSession('fake', 'test-model');
      await store.appendMessage(session, 'user', 'Investigate the flaky test');
      return session.id;
    });

    const listResult = await runCli(
      ['--cwd', workspace, 'sessions', 'list'],
      workspace,
      environmentRoot,
    );
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain(sessionId);
    expect(listResult.stdout).toContain('Investigate the flaky test');

    const renameResult = await runCli(
      ['--cwd', workspace, 'sessions', 'rename', sessionId, 'Flaky test hunt'],
      workspace,
      environmentRoot,
    );
    expect(renameResult.code).toBe(0);
    expect(renameResult.stdout).toContain(`已重命名会话 ${sessionId}`);

    const showResult = await runCli(
      ['--cwd', workspace, 'sessions', 'show', sessionId],
      workspace,
      environmentRoot,
    );
    expect(showResult.code).toBe(0);
    expect(JSON.parse(showResult.stdout)).toMatchObject({
      id: sessionId,
      title: 'Flaky test hunt',
    });
  });

  it('rejects an empty session title with exit code 2', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    const sessionId = await withIsolatedEnv(environmentRoot, async (SessionStoreRef) => {
      const store = await SessionStoreRef.create(workspace);
      const session = await store.createSession('fake', 'test-model');
      return session.id;
    });

    const result = await runCli(
      ['--cwd', workspace, 'sessions', 'rename', sessionId, '   '],
      workspace,
      environmentRoot,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('会话标题不能为空');
  });

  it('pushes the current branch to its upstream with --yes', async () => {
    const { workspace, remote } = await repositoryWithUpstream();
    const branch = await workspaceBranch(workspace);
    await writeFile(path.join(workspace, 'file.txt'), 'world\n');
    await execa('git', ['add', '.'], { cwd: workspace });
    await execa('git', ['commit', '-m', 'second'], { cwd: workspace });

    const result = await runCli(['--cwd', workspace, 'push', '--yes'], workspace, workspace);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('second');
    expect(result.stdout).toContain(`已推送 ${branch} 到 origin`);
    const remoteHead = await execa(
      'git',
      ['--git-dir', remote, 'rev-parse', branch],
      { cwd: workspace },
    );
    const localHead = await execa('git', ['rev-parse', branch], { cwd: workspace });
    expect(remoteHead.stdout.trim()).toBe(localHead.stdout.trim());
  });

  it('pushes a new branch and sets its upstream with --set-upstream', async () => {
    const { workspace, remote } = await repositoryWithUpstream();
    await execa('git', ['checkout', '-b', 'feature'], { cwd: workspace });
    await writeFile(path.join(workspace, 'feature.txt'), 'feature\n');
    await execa('git', ['add', '.'], { cwd: workspace });
    await execa('git', ['commit', '-m', 'feature work'], { cwd: workspace });

    const result = await runCli(
      ['--cwd', workspace, 'push', '--yes', '--set-upstream', '--remote', 'origin'],
      workspace,
      workspace,
    );

    expect(result.code).toBe(0);
    const remoteHead = await execa(
      'git',
      ['--git-dir', remote, 'rev-parse', 'feature'],
      { cwd: workspace },
    );
    const localHead = await execa('git', ['rev-parse', 'feature'], { cwd: workspace });
    expect(remoteHead.stdout.trim()).toBe(localHead.stdout.trim());
  });

  it('requires --yes to push in a non-interactive environment', async () => {
    const { workspace } = await repositoryWithUpstream();
    await writeFile(path.join(workspace, 'file.txt'), 'world\n');
    await execa('git', ['add', '.'], { cwd: workspace });
    await execa('git', ['commit', '-m', 'second'], { cwd: workspace });

    const result = await runCli(['--cwd', workspace, 'push'], workspace, workspace);

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('--yes');
  });

  it('rejects a push without an upstream branch', async () => {
    const workspace = await temporaryDirectory();
    await execa('git', ['init', '--quiet'], { cwd: workspace });
    await execa('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await writeFile(path.join(workspace, 'file.txt'), 'hello\n');
    await execa('git', ['add', '.'], { cwd: workspace });
    await execa('git', ['commit', '-m', 'initial'], { cwd: workspace });

    const result = await runCli(['--cwd', workspace, 'push', '--yes'], workspace, workspace);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('没有上游分支');
  });

  it('rejects a push outside a Git repository', async () => {
    const workspace = await temporaryDirectory();

    const result = await runCli(['--cwd', workspace, 'push', '--yes'], workspace, workspace);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('不是 Git 仓库');
  });
});
