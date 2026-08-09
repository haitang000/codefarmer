import { randomUUID } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import type { JsonObject, ToolDefinition, ToolResult } from '../types.js';
import { atomicWrite, countLineChanges, expectedHash, formatLineStats, sha256FileContent } from './apply-patch.js';
import { ToolError } from './errors.js';
import { requiredString, successfulResult } from './output.js';
import type { MutationOperation, MutationTransaction, ResolvedToolContext } from './types.js';
import type { WorkspaceGuard } from './workspace.js';

export const writeFileDefinition: ToolDefinition = {
  name: 'write_file',
  description:
    'Create a file or overwrite it wholesale with the given UTF-8 content. Prefer apply_patch for targeted edits to existing files; use this when creating a file, rewriting most of one, or when a diff keeps failing to apply.',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      content: { type: 'string', description: 'The complete new file content.' },
      expectedSha256: {
        type: ['string', 'null'],
        description: 'SHA-256 of the existing file, or null when creating it.',
      },
    },
    required: ['path', 'content', 'expectedSha256'],
    additionalProperties: false,
  },
};

/**
 * Whole-content write with the same safety rails as apply_patch: staleness
 * check against the hash read_file returned, approval flow, atomic write, and
 * a recorded transaction so /diff and /undo keep working.
 */
export async function writeWorkspaceFile(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const requestedPath = requiredString(arguments_.path, 'path');
  const content = requiredString(arguments_.content, 'content');
  const expected = expectedHash(arguments_);
  const resolved = await guard.resolveForWrite(requestedPath);
  let beforeBuffer = Buffer.alloc(0);
  let mode: number | undefined;
  if (resolved.exists) {
    const info = await stat(resolved.path);
    if (info.size > context.maxFileBytes) {
      throw new ToolError(
        'FILE_TOO_LARGE',
        `File exceeds the ${String(context.maxFileBytes)} byte limit.`,
      );
    }
    beforeBuffer = await readFile(resolved.path);
    mode = info.mode;
  }
  const beforeHash = resolved.exists ? sha256FileContent(beforeBuffer) : null;
  if (expected !== beforeHash) {
    throw new ToolError(
      'PATCH_CONFLICT',
      `File baseline changed (expected ${expected ?? 'missing'}, got ${beforeHash ?? 'missing'}). The file changed since it was last read; call read_file again to obtain the current content and SHA-256, then retry the write.`,
    );
  }
  const operation: MutationOperation = resolved.exists ? 'modify' : 'create';
  const afterBuffer = Buffer.from(content, 'utf8');
  if (afterBuffer.byteLength > context.maxFileBytes) {
    throw new ToolError(
      'FILE_TOO_LARGE',
      `Content exceeds the ${String(context.maxFileBytes)} byte limit.`,
    );
  }
  if (context.approve !== undefined) {
    const relativeForApproval = guard.toRelative(resolved.path);
    const approved = await context.approve({
      kind: 'file-mutation',
      title: `${operation}: ${relativeForApproval}`,
      detail: content,
      readOnly: false,
    });
    if (!approved)
      throw new ToolError('APPROVAL_DENIED', 'The file change was rejected by the user.');
  }

  const targetPath = resolved.exists
    ? resolved.path
    : await guard.prepareParentForWrite(resolved.path);
  await atomicWrite(targetPath, afterBuffer, mode);

  const beforeContent = resolved.exists
    ? new TextDecoder('utf-8', { fatal: false }).decode(beforeBuffer)
    : null;
  const relativePath = guard.toRelative(targetPath);
  const transaction: MutationTransaction = {
    version: 1,
    id: randomUUID(),
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    workspace: guard.root,
    path: relativePath,
    operation,
    beforeHash,
    afterHash: sha256FileContent(afterBuffer),
    beforeContent,
    ...(mode === undefined ? {} : { beforeMode: mode }),
    afterContent: content,
    diff: content,
    createdAt: new Date().toISOString(),
  };
  try {
    await context.onMutation?.(transaction);
  } catch (error) {
    try {
      if (!resolved.exists) await unlink(targetPath);
      else await atomicWrite(targetPath, beforeBuffer, mode);
    } catch (rollbackError) {
      throw new ToolError(
        'TRANSACTION_FAILED',
        `Mutation audit failed and rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error as Error },
      );
    }
    throw new ToolError(
      'TRANSACTION_FAILED',
      'Mutation audit failed; the file change was rolled back.',
      { cause: error as Error },
    );
  }
  const data: JsonObject = {
    transactionId: transaction.id,
    path: transaction.path,
    operation: transaction.operation,
    beforeHash: transaction.beforeHash,
    afterHash: transaction.afterHash,
  };
  const change = countLineChanges(beforeContent ?? '', content);
  data.addedLines = change.added;
  data.removedLines = change.removed;
  return successfulResult(
    callId,
    'write_file',
    `${operation}: ${relativePath}${formatLineStats(change.added, change.removed)}`,
    { data },
  );
}
