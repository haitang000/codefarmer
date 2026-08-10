import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import {
  commitWorkspaceChanges,
  detectGitAvailability,
  inspectWorkingTree,
  resetGitAvailabilityCache,
} from '../../src/tools/git-tools.js';
import { createToolRegistry } from '../../src/tools/registry.js';

const temporaryDirectories: string[] = [];

async function repository(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-git-'));
  temporaryDirectories.push(root);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  await execa('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'outside.txt'), 'outside baseline\n');
  await writeFile(path.join(workspace, 'inside.txt'), 'inside baseline\n');
  await execa('git', ['add', '.'], { cwd: root });
  return { root, workspace };
}

async function commit(root: string, message: string): Promise<void> {
  await execa(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message],
    { cwd: root },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Git tools', () => {
  it('limits status and diff output to the configured workspace', async () => {
    const { root, workspace } = await repository();
    await writeFile(path.join(root, 'outside.txt'), 'outside changed\n');
    await writeFile(path.join(workspace, 'inside.txt'), 'inside changed\n');
    await execa('git', ['config', 'diff.external', 'definitely-not-a-real-command'], { cwd: root });
    const registry = await createToolRegistry({ workspace });

    const status = await registry.execute({
      callId: 'status',
      name: 'git_status',
      arguments: {},
    });
    const diff = await registry.execute({
      callId: 'diff',
      name: 'git_diff',
      arguments: { staged: null, path: null },
    });

    expect(status.success).toBe(true);
    expect(status.output).toContain('inside.txt');
    expect(status.output).not.toContain('outside.txt');
    expect(diff.success).toBe(true);
    expect(diff.output).toContain('inside changed');
    expect(diff.output).not.toContain('outside changed');
  });

  it('shows commit history limited to the workspace with git_log', async () => {
    const { root, workspace } = await repository();
    await commit(root, 'baseline');
    await writeFile(path.join(workspace, 'inside.txt'), 'inside changed\n');
    await execa('git', ['add', '.'], { cwd: root });
    await commit(root, 'inside change');
    await writeFile(path.join(root, 'outside.txt'), 'outside changed\n');
    await execa('git', ['add', '.'], { cwd: root });
    await commit(root, 'outside change');

    const registry = await createToolRegistry({ workspace });
    const log = await registry.execute({
      callId: 'log',
      name: 'git_log',
      arguments: { limit: null, path: null },
    });
    const limited = await registry.execute({
      callId: 'log-limited',
      name: 'git_log',
      arguments: { limit: 1, path: null },
    });
    const byPath = await registry.execute({
      callId: 'log-path',
      name: 'git_log',
      arguments: { limit: null, path: 'inside.txt' },
    });

    expect(log.success).toBe(true);
    expect(log.output).toContain('inside change');
    expect(log.output).toContain('baseline');
    expect(log.output).not.toContain('outside change');
    expect(log.data).toEqual({ limit: 20, path: null });
    expect(limited.success).toBe(true);
    expect(limited.output).toContain('inside change');
    expect(limited.output).not.toContain('baseline');
    expect(byPath.success).toBe(true);
    expect(byPath.output).toContain('inside change');
    expect(byPath.output).not.toContain('outside change');
    expect(byPath.data).toEqual({ limit: 20, path: 'inside.txt' });
  });

  it('shows a commit patch and statistics with git_show, limited to the workspace', async () => {
    const { root, workspace } = await repository();
    await commit(root, 'baseline');
    await writeFile(path.join(workspace, 'inside.txt'), 'inside changed\n');
    await execa('git', ['add', '.'], { cwd: root });
    await commit(root, 'inside change');
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const baseline = (await execa('git', ['rev-parse', 'HEAD~1'], { cwd: root })).stdout.trim();

    const registry = await createToolRegistry({ workspace });
    const show = await registry.execute({
      callId: 'show',
      name: 'git_show',
      arguments: { commit: head, stat: null, path: null },
    });
    const stat = await registry.execute({
      callId: 'show-stat',
      name: 'git_show',
      arguments: { commit: head, stat: true, path: null },
    });
    const baselineShow = await registry.execute({
      callId: 'show-baseline',
      name: 'git_show',
      arguments: { commit: baseline, stat: null, path: null },
    });

    expect(show.success).toBe(true);
    expect(show.output).toContain('inside change');
    expect(show.output).toContain('+inside changed');
    expect(show.output).toContain('-inside baseline');
    expect(show.data).toEqual({ commit: head, stat: false, path: null });
    expect(stat.success).toBe(true);
    expect(stat.output).toContain('inside.txt');
    expect(stat.output).not.toContain('+inside changed');
    // The baseline commit also touched a file outside the workspace; the
    // patch must stay inside the configured boundary.
    expect(baselineShow.success).toBe(true);
    expect(baselineShow.output).toContain('inside.txt');
    expect(baselineShow.output).not.toContain('outside.txt');
  });

  it('rejects invalid git_log and git_show arguments', async () => {
    const { workspace } = await repository();
    const registry = await createToolRegistry({ workspace });

    const optionLike = await registry.execute({
      callId: 'option-like',
      name: 'git_show',
      arguments: { commit: '--stat', stat: null, path: null },
    });
    const emptyCommit = await registry.execute({
      callId: 'empty-commit',
      name: 'git_show',
      arguments: { commit: '', stat: null, path: null },
    });
    const badLimit = await registry.execute({
      callId: 'bad-limit',
      name: 'git_log',
      arguments: { limit: 0, path: null },
    });
    const missingPath = await registry.execute({
      callId: 'missing-path',
      name: 'git_show',
      arguments: { commit: 'HEAD', stat: null, path: 'does-not-exist.txt' },
    });

    expect(optionLike.success).toBe(false);
    expect(optionLike.error?.code).toBe('INVALID_ARGUMENT');
    expect(emptyCommit.success).toBe(false);
    expect(emptyCommit.error?.code).toBe('INVALID_ARGUMENT');
    expect(badLimit.success).toBe(false);
    expect(badLimit.error?.code).toBe('INVALID_ARGUMENT');
    expect(missingPath.success).toBe(false);
    expect(missingPath.error?.code).toBe('PATH_NOT_FOUND');
  });

  it('reports a clear error when the workspace is not a Git repository', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-nogit-'));
    temporaryDirectories.push(workspace);
    resetGitAvailabilityCache();
    const registry = await createToolRegistry({ workspace });

    const status = await registry.execute({
      callId: 'status',
      name: 'git_status',
      arguments: {},
    });

    expect(status.success).toBe(false);
    expect(status.error?.code).toBe('GIT_UNAVAILABLE');
    expect(status.error?.message).toContain('not a Git repository');
  });

  it('stages and commits workspace changes with commitWorkspaceChanges', async () => {
    const { root, workspace } = await repository();
    await commit(root, 'baseline');
    // The helper never fabricates a Git identity; the test repo provides one.
    await execa('git', ['config', 'user.name', 'Test'], { cwd: root });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await writeFile(path.join(workspace, 'inside.txt'), 'inside changed\n');
    await writeFile(path.join(workspace, 'new.txt'), 'new file\n');

    const first = await commitWorkspaceChanges({ workspace, message: 'custom message' });
    expect(first.status).toBe('committed');
    if (first.status === 'committed') {
      expect(first.message).toBe('custom message');
      expect(first.files).toEqual(expect.arrayContaining(['inside.txt', 'new.txt']));
      expect(first.hash).toMatch(/^[0-9a-f]{7,}$/u);
    }

    expect(await commitWorkspaceChanges({ workspace })).toEqual({ status: 'clean' });

    // Without a message, a subject is derived from the changed paths.
    await writeFile(path.join(workspace, 'another.txt'), 'x\n');
    const derived = await commitWorkspaceChanges({ workspace });
    expect(derived.status).toBe('committed');
    if (derived.status === 'committed') {
      expect(derived.message).toContain('another.txt');
    }

    const log = await execa('git', ['log', '--oneline', '-2'], { cwd: root });
    expect(log.stdout).toContain('custom message');
  });

  it('reports when commitWorkspaceChanges cannot find a repository or Git', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-nogit-'));
    temporaryDirectories.push(workspace);
    resetGitAvailabilityCache();
    expect(await commitWorkspaceChanges({ workspace })).toEqual({ status: 'not-a-repository' });

    const { workspace: repositoryWorkspace } = await repository();
    const originalPath = process.env.PATH;
    resetGitAvailabilityCache();
    process.env.PATH = '';
    try {
      expect(await commitWorkspaceChanges({ workspace: repositoryWorkspace })).toEqual({
        status: 'git-unavailable',
      });
    } finally {
      process.env.PATH = originalPath;
      resetGitAvailabilityCache();
    }
  });

  it('inspects the working tree without staging or committing', async () => {
    const { root, workspace } = await repository();
    await commit(root, 'baseline');

    expect(await inspectWorkingTree(workspace)).toEqual({ status: 'clean' });

    await writeFile(path.join(workspace, 'inside.txt'), 'inside changed\n');
    await writeFile(path.join(workspace, 'new.txt'), 'new file\n');
    const dirty = await inspectWorkingTree(workspace);
    expect(dirty.status).toBe('dirty');
    if (dirty.status === 'dirty') {
      expect(dirty.files).toEqual(expect.arrayContaining(['inside.txt', 'new.txt']));
    }

    // Nothing was staged or committed by the inspection itself.
    const log = await execa('git', ['log', '--oneline'], { cwd: root });
    expect(log.stdout).toContain('baseline');
    expect(log.stdout).not.toContain('inside changed');
  });

  it('reports repository and Git availability from inspectWorkingTree', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-nogit-'));
    temporaryDirectories.push(workspace);
    resetGitAvailabilityCache();
    expect(await inspectWorkingTree(workspace)).toEqual({ status: 'not-a-repository' });

    const { workspace: repositoryWorkspace } = await repository();
    const originalPath = process.env.PATH;
    resetGitAvailabilityCache();
    process.env.PATH = '';
    try {
      expect(await inspectWorkingTree(repositoryWorkspace)).toEqual({
        status: 'git-unavailable',
      });
    } finally {
      process.env.PATH = originalPath;
      resetGitAvailabilityCache();
    }
  });

  it('fails gracefully when Git is not available', async () => {
    const { workspace } = await repository();
    const registry = await createToolRegistry({ workspace });
    const originalPath = process.env.PATH;
    resetGitAvailabilityCache();
    process.env.PATH = '';
    try {
      expect((await detectGitAvailability()).available).toBe(false);
      expect(await commitWorkspaceChanges({ workspace })).toEqual({ status: 'git-unavailable' });
      expect(await inspectWorkingTree(workspace)).toEqual({ status: 'git-unavailable' });
      const status = await registry.execute({
        callId: 'status',
        name: 'git_status',
        arguments: {},
      });
      const diff = await registry.execute({
        callId: 'diff',
        name: 'git_diff',
        arguments: { staged: null, path: null },
      });
      const log = await registry.execute({
        callId: 'log',
        name: 'git_log',
        arguments: { limit: null, path: null },
      });
      const show = await registry.execute({
        callId: 'show',
        name: 'git_show',
        arguments: { commit: 'HEAD', stat: null, path: null },
      });
      expect(status.success).toBe(false);
      expect(status.error?.code).toBe('GIT_UNAVAILABLE');
      expect(diff.success).toBe(false);
      expect(diff.error?.code).toBe('GIT_UNAVAILABLE');
      expect(log.success).toBe(false);
      expect(log.error?.code).toBe('GIT_UNAVAILABLE');
      expect(show.success).toBe(false);
      expect(show.error?.code).toBe('GIT_UNAVAILABLE');
    } finally {
      process.env.PATH = originalPath;
      resetGitAvailabilityCache();
    }
  });
});
