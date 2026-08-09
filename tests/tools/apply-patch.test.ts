import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MutationTransaction } from '../../src/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreMutation } from '../../src/tools/apply-patch.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { WorkspaceGuard } from '../../src/tools/workspace.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-patch-'));
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

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('apply_patch', () => {
  it('updates a file while preserving CRLF and records an undo transaction', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'one\r\ntwo\r\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    let mutation: MutationTransaction | undefined;
    const registry = await createToolRegistry({
      workspace,
      approve: () => true,
      onMutation: (value) => {
        mutation = value;
      },
    });
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+changed',
      '',
    ].join('\n');

    const result = await registry.execute({
      callId: 'patch-1',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });
    expect(result).toMatchObject({ success: true, callId: 'patch-1' });
    expect(result.output).toBe('modify: file.txt (+1 -1)');
    expect(result.data).toMatchObject({ addedLines: 1, removedLines: 1 });
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe('one\r\nchanged\r\n');
    if (mutation === undefined) throw new Error('Mutation callback was not called.');
    expect(mutation).toMatchObject({ operation: 'modify', beforeHash: hash(original) });

    const guard = await WorkspaceGuard.create(workspace);
    await restoreMutation(mutation, guard);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe(original);
  });

  it('creates nested parents only after approval', async () => {
    const workspace = await temporaryWorkspace();
    const patch = [
      '--- /dev/null',
      '+++ b/src/nested/new.ts',
      '@@ -0,0 +1 @@',
      '+export const value = 1;',
      '',
    ].join('\n');
    const deniedRegistry = await createToolRegistry({ workspace, approve: () => false });
    const denied = await deniedRegistry.execute({
      callId: 'denied',
      name: 'apply_patch',
      arguments: { path: 'src/nested/new.ts', patch, expectedSha256: null },
    });
    expect(denied).toMatchObject({ success: false, error: { code: 'APPROVAL_DENIED' } });
    await expect(access(path.join(workspace, 'src'))).rejects.toBeDefined();

    const approvedRegistry = await createToolRegistry({ workspace, approve: () => true });
    const created = await approvedRegistry.execute({
      callId: 'created',
      name: 'apply_patch',
      arguments: { path: 'src/nested/new.ts', patch, expectedSha256: null },
    });
    expect(created.success).toBe(true);
    expect(await readFile(path.join(workspace, 'src', 'nested', 'new.ts'), 'utf8')).toBe(
      'export const value = 1;\n',
    );
  });

  it('rejects stale hashes without writing or requesting approval', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'file.txt'), 'current\n');
    const approve = vi.fn(() => true);
    const registry = await createToolRegistry({ workspace, approve });
    const result = await registry.execute({
      callId: 'stale',
      name: 'apply_patch',
      arguments: {
        path: 'file.txt',
        patch: '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-current\n+new\n',
        expectedSha256: hash('old\n'),
      },
    });

    expect(result).toMatchObject({ success: false, error: { code: 'PATCH_CONFLICT' } });
    expect(approve).not.toHaveBeenCalled();
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe('current\n');
  });

  it('deletes a file and can restore it from the transaction snapshot', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'remove me\n';
    await writeFile(path.join(workspace, 'delete.txt'), original);
    let mutation: MutationTransaction | undefined;
    const registry = await createToolRegistry({
      workspace,
      onMutation: (value) => {
        mutation = value;
      },
    });
    const result = await registry.execute({
      callId: 'delete',
      name: 'apply_patch',
      arguments: {
        path: 'delete.txt',
        patch: '--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-remove me\n',
        expectedSha256: hash(original),
      },
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('delete: delete.txt (-1)');
    await expect(access(path.join(workspace, 'delete.txt'))).rejects.toBeDefined();
    if (mutation === undefined) throw new Error('Mutation callback was not called.');

    await restoreMutation(mutation, await WorkspaceGuard.create(workspace));
    expect(await readFile(path.join(workspace, 'delete.txt'), 'utf8')).toBe(original);
  });

  it('rolls back the file when transaction persistence fails', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'before\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({
      workspace,
      approve: () => true,
      onMutation: () => {
        throw new Error('storage unavailable');
      },
    });
    const result = await registry.execute({
      callId: 'audit-failure',
      name: 'apply_patch',
      arguments: {
        path: 'file.txt',
        patch: '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n',
        expectedSha256: hash(original),
      },
    });
    expect(result).toMatchObject({ success: false, error: { code: 'TRANSACTION_FAILED' } });
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe(original);
  });

  it('recovers from drifted hunk line numbers with a nearby exact match', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'alpha\nbeta\ngamma\ndelta\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,2 +1,2 @@',
      '-gamma',
      '+GAMMA',
      ' delta',
      '',
    ].join('\n');

    const result = await registry.execute({
      callId: 'drift',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe(
      'alpha\nbeta\nGAMMA\ndelta\n',
    );
  });

  it('accepts context lines whose space prefix was dropped by the model', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'alpha\nbeta\ngamma\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+BETA',
      'gamma',
      '',
    ].join('\n');

    const result = await registry.execute({
      callId: 'missing-prefix',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe(
      'alpha\nBETA\ngamma\n',
    );
  });

  it('treats a blank line inside a hunk as an empty context line', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'a\n\nb\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const patch = ['--- a/file.txt', '+++ b/file.txt', '@@ -1,3 +1,3 @@', ' a', '', '-b', '+B'].join(
      '\n',
    );

    const result = await registry.execute({
      callId: 'blank-context',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe('a\n\nB\n');
  });

  it('applies a hunk whose header under-counts the emitted lines', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'alpha\nbeta\ngamma\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    // The header declares -2/+2 but the body actually contains -3/+4, the
    // exact mistake weaker models make when they stop counting mid-hunk.
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-beta',
      '+BETA',
      '+       file.size,',
      ' gamma',
    ].join('\n');

    const result = await registry.execute({
      callId: 'under-counted',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe(
      'alpha\nBETA\n       file.size,\ngamma\n',
    );
  });

  it('accepts a hunk that ends before its declared counts are satisfied', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'alpha\nbeta\ngamma\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    // The header declares -10/+10 but the hunk body only has -3/+3 lines.
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,10 +1,10 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
    ].join('\n');

    const result = await registry.execute({
      callId: 'over-counted',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');
  });

  it('creates a file whose create hunk under-counts the added lines', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const patch = [
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+first',
      '+second',
      '+third',
    ].join('\n');

    const result = await registry.execute({
      callId: 'create-under-counted',
      name: 'apply_patch',
      arguments: { path: 'new.txt', patch, expectedSha256: null },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('create: new.txt (+3)');
    expect(await readFile(path.join(workspace, 'new.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
  });

  it('accepts blank lines inside a file-creation hunk', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace, approve: () => true });
    // Source files are full of blank lines between blocks, and models emit
    // them without any prefix. Creation hunks have no old side, so a blank
    // line can only be an empty addition.
    const patch = [
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,5 @@',
      '+import { x } from "./x.js";',
      '',
      '+export function main() {',
      '+  return x;',
      '+}',
    ].join('\n');

    const result = await registry.execute({
      callId: 'create-with-blank',
      name: 'apply_patch',
      arguments: { path: 'new.ts', patch, expectedSha256: null },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'new.ts'), 'utf8')).toBe(
      'import { x } from "./x.js";\n\nexport function main() {\n  return x;\n}\n',
    );
  });

  it('treats a bare blank line as an empty addition once the old side is done', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'old\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    // The blank line between the additions lost its '+' prefix.
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,1 +1,4 @@',
      '-old',
      '+new',
      '',
      '+tail',
    ].join('\n');

    const result = await registry.execute({
      callId: 'blank-addition',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe('new\n\ntail\n');
  });

  it('does not absorb a trailing blank line after a complete hunk', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'a\nb\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const patch = ['--- a/file.txt', '+++ b/file.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '+c', ''].join(
      '\n',
    );

    const result = await registry.execute({
      callId: 'trailing-blank',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe('a\nc\n');
  });

  it('matches first-line context in a file that starts with a UTF-8 BOM', async () => {
    const workspace = await temporaryWorkspace();
    // Files written by tools like PowerShell 5.1's Set-Content -Encoding UTF8
    // carry a BOM; the model cannot see it in read_file output, so matching
    // must ignore it.
    const original = '﻿line one\nline two\n';
    await writeFile(path.join(workspace, 'bom.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const patch = [
      '--- a/bom.txt',
      '+++ b/bom.txt',
      '@@ -1,2 +1,2 @@',
      ' line one',
      '-line two',
      '+LINE TWO',
    ].join('\n');

    const result = await registry.execute({
      callId: 'bom-match',
      name: 'apply_patch',
      arguments: { path: 'bom.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'bom.txt'), 'utf8')).toBe('line one\nLINE TWO\n');
  });

  it('synthesizes missing ---/+++ headers for an existing file', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'alpha\nbeta\ngamma\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    // Weak models sometimes drop the file headers entirely and send only hunks.
    const patch = ['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+BETA', ' gamma'].join('\n');

    const result = await registry.execute({
      callId: 'missing-headers',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe(
      'alpha\nBETA\ngamma\n',
    );
  });

  it('synthesizes missing headers as a creation patch for a new file', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const patch = ['@@ -0,0 +1,2 @@', '+first', '+second'].join('\n');

    const result = await registry.execute({
      callId: 'missing-headers-create',
      name: 'apply_patch',
      arguments: { path: 'new.txt', patch, expectedSha256: null },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'new.txt'), 'utf8')).toBe('first\nsecond\n');
  });

  it('applies a hunk whose @@ header carries no line numbers at all', async () => {
    const workspace = await temporaryWorkspace();
    // Keep the target well beyond the drift radius so recovery must search
    // the whole file, not just nearby offsets.
    const filler = Array.from({ length: 700 }, (_, index) => `line ${String(index + 1)}`);
    const original = [...filler, 'target', 'tail'].join('\n') + '\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@',
      '-target',
      '+TARGET',
      ' tail',
    ].join('\n');

    const result = await registry.execute({
      callId: 'bare-hunk-header',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe(
      [...filler, 'TARGET', 'tail'].join('\n') + '\n',
    );
  });

  it('estimates counts when the @@ header omits them', async () => {
    const workspace = await temporaryWorkspace();
    const original = 'alpha\n\nbeta\ngamma\n';
    await writeFile(path.join(workspace, 'file.txt'), original);
    const registry = await createToolRegistry({ workspace, approve: () => true });
    // No counts declared; the blank context line lost its space prefix.
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -2 @@',
      '',
      '-beta',
      '+BETA',
      ' gamma',
    ].join('\n');

    const result = await registry.execute({
      callId: 'missing-counts',
      name: 'apply_patch',
      arguments: { path: 'file.txt', patch, expectedSha256: hash(original) },
    });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(workspace, 'file.txt'), 'utf8')).toBe(
      'alpha\n\nBETA\ngamma\n',
    );
  });
});
