import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/tools/errors.js';
import { WorkspaceGuard, isIgnoredRelativePath } from '../../src/tools/workspace.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-tools-'));
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

describe('WorkspaceGuard', () => {
  it('rejects traversal and absolute paths', async () => {
    const workspace = await temporaryDirectory();
    const guard = await WorkspaceGuard.create(workspace);

    await expect(guard.resolveExisting('../outside.txt')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
    await expect(guard.resolveExisting(path.resolve(workspace, 'file.txt'))).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  });

  it('keeps hard secret rules and adds project ignore patterns', async () => {
    const workspace = await temporaryDirectory();
    await mkdir(path.join(workspace, 'generated'));
    await writeFile(path.join(workspace, '.env'), 'SECRET=value');
    await writeFile(path.join(workspace, '.env.example'), 'SECRET=');
    await writeFile(path.join(workspace, 'generated', 'file.ts'), 'generated');
    const guard = await WorkspaceGuard.create(workspace, ['generated/**', '!.env']);

    expect(isIgnoredRelativePath('.env.example')).toBe(false);
    expect(isIgnoredRelativePath('src/__pycache__/mod.cpython-312.pyc')).toBe(true);
    expect(isIgnoredRelativePath('.venv/lib/python3.12/site.py')).toBe(true);
    expect(isIgnoredRelativePath('.DS_Store')).toBe(true);
    await expect(guard.resolveExisting('.env')).rejects.toMatchObject({ code: 'PATH_IGNORED' });
    await expect(guard.resolveExisting('generated/file.ts')).rejects.toMatchObject({
      code: 'PATH_IGNORED',
    });
    await expect(guard.resolveExisting('.env.example', { kind: 'file' })).resolves.toBeTypeOf(
      'string',
    );
  });

  it('rejects a symbolic link that resolves outside the workspace', async () => {
    const workspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(
        outside,
        path.join(workspace, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const guard = await WorkspaceGuard.create(workspace);

    await expect(guard.resolveExisting('escape/secret.txt')).rejects.toBeInstanceOf(ToolError);
    await expect(guard.resolveExisting('escape/secret.txt')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  });
});
