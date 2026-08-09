import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { ConflictError, PersistenceError } from '../infra/errors.js';
import { ensureWorkspaceDirectories, getWorkspacePaths } from '../infra/paths.js';
import { readJsonFile, writeJsonAtomic } from '../infra/persistence.js';
import { restoreMutation } from '../tools/apply-patch.js';
import { ToolError } from '../tools/errors.js';
import { WorkspaceGuard } from '../tools/workspace.js';
import type { MutationTransaction } from '../types.js';

function transactionFile(directory: string, transaction: MutationTransaction): string {
  const timestamp = transaction.createdAt.replaceAll(/[^0-9]/g, '');
  return path.join(directory, `${timestamp}-${transaction.id}.json`);
}

export class TransactionStore {
  private constructor(
    private readonly workspace: string,
    private readonly directory: string,
  ) {}

  public static async create(workspace: string): Promise<TransactionStore> {
    const paths = await getWorkspacePaths(workspace);
    await ensureWorkspaceDirectories(paths);
    return new TransactionStore(paths.workspace, paths.transactions);
  }

  public async record(transaction: MutationTransaction): Promise<void> {
    if (path.resolve(transaction.workspace) !== path.resolve(this.workspace)) {
      throw new PersistenceError('变更事务不属于当前工作区');
    }
    await writeJsonAtomic(transactionFile(this.directory, transaction), transaction);
  }

  public async list(): Promise<MutationTransaction[]> {
    const files = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(this.directory, entry.name));
    const transactions = await Promise.all(
      files.map((file) => readJsonFile<MutationTransaction>(file)),
    );
    return transactions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public async undoLatest(sessionId?: string): Promise<MutationTransaction> {
    const transaction = (await this.list()).find(
      (candidate) =>
        candidate.undoneAt === undefined &&
        (sessionId === undefined || candidate.sessionId === sessionId),
    );
    if (transaction === undefined) throw new ConflictError('没有可撤销的文件变更');

    const guard = await WorkspaceGuard.create(this.workspace);
    try {
      const restored = await restoreMutation(transaction, guard, Number.MAX_SAFE_INTEGER);
      if (restored.undoneAt === undefined) throw new PersistenceError('撤销没有生成完成时间');
      transaction.undoneAt = restored.undoneAt;
    } catch (error) {
      if (error instanceof ToolError && error.code === 'PATCH_CONFLICT') {
        throw new ConflictError(error.message, { cause: error });
      }
      throw error;
    }
    const files = await readdir(this.directory);
    const matching = files.find((name) => name.endsWith(`${transaction.id}.json`));
    if (matching === undefined) throw new PersistenceError('撤销成功，但找不到事务记录');
    await writeJsonAtomic(path.join(this.directory, matching), transaction);
    return transaction;
  }
}
