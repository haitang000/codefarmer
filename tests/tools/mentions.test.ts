import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  completePathMention,
  expandPathMentions,
  extractPathMentions,
  mentionAtCursor,
} from '../../src/tools/mentions.js';
import { WorkspaceGuard } from '../../src/tools/workspace.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-mentions-'));
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

describe('path mentions', () => {
  it('extracts @path tokens and ignores email-like text', () => {
    expect(extractPathMentions('fix @src/cli.ts and @README.md please')).toEqual([
      'src/cli.ts',
      'README.md',
    ]);
    expect(extractPathMentions('email me at user@example.com')).toEqual([]);
    expect(extractPathMentions('@src/app.ts, then stop')).toEqual(['src/app.ts']);
  });

  it('finds the mention under the cursor', () => {
    const text = 'see @src/cli.ts now';
    expect(mentionAtCursor(text, 6)?.path).toBe('src/cli.ts');
    expect(mentionAtCursor(text, 0)).toBeUndefined();
    expect(mentionAtCursor(text, text.length)).toBeUndefined();
  });

  it('attaches numbered file contents and lists directories', async () => {
    const workspace = await temporaryWorkspace();
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'hello.ts'), 'export const hello = 1;\n');
    await writeFile(path.join(workspace, 'src', 'other.ts'), 'export const other = 2;\n');

    const expanded = await expandPathMentions('Look at @src/hello.ts and @src', {
      workspace,
      ignoredPaths: [],
      maxFileBytes: 10_000,
    });
    expect(expanded.attached).toEqual(['src/hello.ts', 'src']);
    expect(expanded.prompt).toContain('<attached_files>');
    expect(expanded.prompt).toContain('1|export const hello = 1;');
    expect(expanded.prompt).toContain('hello.ts');
    expect(expanded.missing).toEqual([]);
  });

  it('completes a unique path prefix', async () => {
    const workspace = await temporaryWorkspace();
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'cli.ts'), 'ok\n');
    const guard = await WorkspaceGuard.create(workspace);
    await expect(completePathMention('src/c', guard)).resolves.toBe('src/cli.ts');
  });
});
