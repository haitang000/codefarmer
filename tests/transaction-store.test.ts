import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TransactionStore } from '../src/core/transaction-store.js';
import { ConflictError } from '../src/infra/errors.js';
import { canonicalWorkspace } from '../src/infra/paths.js';
import type { MutationTransaction } from '../src/types.js';

const temporaryDirectories: string[] = [];

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-transactions-'));
  temporaryDirectories.push(directory);
  return directory;
}

function transaction(root: string, before: string, after: string): MutationTransaction {
  return {
    version: 1,
    id: 'transaction-1',
    workspace: root,
    path: 'file.txt',
    operation: 'modify',
    beforeHash: hash(before),
    afterHash: hash(after),
    beforeContent: before,
    afterContent: after,
    diff: 'test diff',
    createdAt: new Date().toISOString(),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('TransactionStore', () => {
  it('restores the latest transaction and marks it undone', async () => {
    const root = await workspace();
    const before = 'before\r\n';
    const after = 'after\r\n';
    await writeFile(path.join(root, 'file.txt'), after);
    const store = await TransactionStore.create(root);
    await store.record(transaction(root, before, after));

    expect((await store.list())[0]?.workspace).toBe(await canonicalWorkspace(root));

    const undone = await store.undoLatest();

    expect(undone.undoneAt).toBeTypeOf('string');
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe(before);
    expect((await store.list())[0]?.undoneAt).toBe(undone.undoneAt);
  });

  it('refuses to overwrite a file changed after the recorded mutation', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'file.txt'), 'external\n');
    const store = await TransactionStore.create(root);
    await store.record(transaction(root, 'before\n', 'after\n'));

    await expect(store.undoLatest()).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('external\n');
  });
});
