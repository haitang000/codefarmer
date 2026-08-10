import type { JsonObject, ToolDefinition, ToolResult } from '../types.js';
import { ToolError } from './errors.js';
import {
  invalidArgument,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredString,
  truncateUtf8,
} from './output.js';
import { executeProcess } from './run-command.js';
import type { ResolvedToolContext } from './types.js';
import type { WorkspaceGuard } from './workspace.js';

export const gitStatusDefinition: ToolDefinition = {
  name: 'git_status',
  description: 'Show the current workspace Git status without modifying the repository.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export const gitDiffDefinition: ToolDefinition = {
  name: 'git_diff',
  description: 'Show a safe Git diff with external diff and text conversion disabled.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      staged: { type: ['boolean', 'null'] },
      path: { type: ['string', 'null'], description: 'Optional workspace-relative file path.' },
    },
    required: ['staged', 'path'],
    additionalProperties: false,
  },
};

export const gitLogDefinition: ToolDefinition = {
  name: 'git_log',
  description: 'Show commit history without modifying the repository.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Maximum number of commits to show (1-100).',
      },
      path: {
        type: ['string', 'null'],
        description: 'Optional workspace-relative file or directory path to filter history.',
      },
    },
    required: ['limit', 'path'],
    additionalProperties: false,
  },
};

export const gitShowDefinition: ToolDefinition = {
  name: 'git_show',
  description:
    'Show a commit (message and patch) without modifying the repository. Use git_log to find commit hashes.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      commit: {
        type: 'string',
        description: 'Revision to show, for example HEAD, a commit hash, or HEAD~2.',
      },
      stat: {
        type: ['boolean', 'null'],
        description: 'Show file statistics instead of the full patch.',
      },
      path: {
        type: ['string', 'null'],
        description: 'Optional workspace-relative path to limit the shown changes.',
      },
    },
    required: ['commit', 'stat', 'path'],
    additionalProperties: false,
  },
};

export interface GitAvailability {
  available: boolean;
  version?: string;
}

let cachedGitAvailability: GitAvailability | undefined;

/** Detect whether the `git` executable is on PATH; cached for the process lifetime. */
export async function detectGitAvailability(force = false): Promise<GitAvailability> {
  if (cachedGitAvailability !== undefined && !force) return cachedGitAvailability;
  try {
    const result = await executeProcess('git', ['--version'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maximumBufferBytes: 4096,
    });
    cachedGitAvailability =
      result.exitCode === 0
        ? { available: true, version: result.stdout.trim() }
        : { available: false };
  } catch {
    cachedGitAvailability = { available: false };
  }
  return cachedGitAvailability;
}

export function resetGitAvailabilityCache(): void {
  cachedGitAvailability = undefined;
}

async function executeGit(
  args: string[],
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<{ output: string; truncated: boolean }> {
  const availability = await detectGitAvailability();
  if (!availability.available) {
    throw new ToolError(
      'GIT_UNAVAILABLE',
      'Git is not installed or not on PATH. Git is optional; continue with the file tools instead.',
    );
  }
  const result = await executeProcess('git', args, {
    cwd: guard.root,
    timeoutMs: Math.min(context.commandTimeoutMs, 120_000),
    maximumBufferBytes: context.maxOutputBytes,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    environment: {
      GIT_EXTERNAL_DIFF: '',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    },
  });
  const combined =
    result.stderr.length === 0
      ? result.stdout
      : `${result.stdout}${result.stdout.length === 0 ? '' : '\n'}[stderr]\n${result.stderr}`;
  const rendered = truncateUtf8(combined, context.maxOutputBytes);
  if (result.timedOut) throw new ToolError('COMMAND_TIMEOUT', 'Git command timed out.');
  if (result.exitCode !== 0) {
    if (/not a git repository/iu.test(result.stderr)) {
      throw new ToolError(
        'GIT_UNAVAILABLE',
        'The workspace is not a Git repository, so Git status and diff are unavailable here. Continue with the file tools.',
      );
    }
    throw new ToolError(
      'GIT_FAILED',
      rendered.text.length > 0
        ? rendered.text
        : `Git exited with code ${result.exitCode === null ? 'unknown' : String(result.exitCode)}.`,
    );
  }
  return { output: rendered.text, truncated: rendered.truncated };
}

export async function gitStatus(
  callId: string,
  _arguments: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const result = await executeGit(
    [
      '--no-pager',
      '-c',
      'core.fsmonitor=false',
      'status',
      '--short',
      '--branch',
      '--untracked-files=all',
      '--',
      '.',
    ],
    context,
    guard,
  );
  return {
    callId,
    toolName: 'git_status',
    success: true,
    output: result.output,
    truncated: result.truncated,
  };
}

export async function gitDiff(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const staged = optionalBoolean(arguments_.staged, 'staged', false);
  // Some gateways stringify a JSON `null` argument into the literal text
  // "null"; treat such values as "no path filter".
  const requestedPath =
    arguments_.path === 'null' || arguments_.path === 'undefined'
      ? undefined
      : optionalString(arguments_.path, 'path');
  const args = [
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
  ];
  if (staged) args.push('--cached');
  if (requestedPath !== undefined) {
    const absolutePath = await guard.resolveExisting(requestedPath, { kind: 'file' });
    args.push('--', guard.toRelative(absolutePath));
  } else {
    args.push('--', '.');
  }
  const result = await executeGit(args, context, guard);
  const data: JsonObject = { staged, path: requestedPath ?? null };
  return {
    callId,
    toolName: 'git_diff',
    success: true,
    output: result.output,
    data,
    truncated: result.truncated,
  };
}

export async function gitLog(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const limit = optionalInteger(arguments_.limit, 'limit', 20, 1, 100);
  // Some gateways stringify a JSON `null` argument into the literal text
  // "null"; optionalString normalizes those back to "no path filter".
  const requestedPath = optionalString(arguments_.path, 'path');
  const args = [
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    'log',
    '--date=short',
    '--pretty=format:%h %ad %an %s',
    `-n ${String(limit)}`,
  ];
  if (requestedPath !== undefined) {
    const absolutePath = await guard.resolveExisting(requestedPath, { kind: 'any' });
    args.push('--', guard.toRelative(absolutePath));
  } else {
    // Like git_status and git_diff, limit the history to the workspace so the
    // tool never reveals repository content outside the configured boundary.
    args.push('--', '.');
  }
  const result = await executeGit(args, context, guard);
  const data: JsonObject = { limit, path: requestedPath ?? null };
  return {
    callId,
    toolName: 'git_log',
    success: true,
    output: result.output,
    data,
    truncated: result.truncated,
  };
}

export async function gitShow(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
  guard: WorkspaceGuard,
): Promise<ToolResult> {
  const commit = requiredString(arguments_.commit, 'commit');
  if (commit.startsWith('-')) {
    invalidArgument('commit must be a revision such as HEAD or a commit hash, not an option.');
  }
  const stat = optionalBoolean(arguments_.stat, 'stat', false);
  const requestedPath = optionalString(arguments_.path, 'path');
  const args = [
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    'show',
    '--no-ext-diff',
    '--no-textconv',
  ];
  if (stat) args.push('--stat');
  args.push(commit);
  if (requestedPath !== undefined) {
    const absolutePath = await guard.resolveExisting(requestedPath, { kind: 'any' });
    args.push('--', guard.toRelative(absolutePath));
  } else {
    // Keep the shown changes inside the configured workspace boundary.
    args.push('--', '.');
  }
  const result = await executeGit(args, context, guard);
  const data: JsonObject = { commit, stat, path: requestedPath ?? null };
  return {
    callId,
    toolName: 'git_show',
    success: true,
    output: result.output,
    data,
    truncated: result.truncated,
  };
}

// ---------------------------------------------------------------------------
// TUI-only workspace commit helper (NOT an agent tool).
//
// `/commit` is invoked by the user from the interactive TUI, so it may stage
// and commit. The agent tools above stay read-only: this function is exported
// for the TUI but is never registered in the tool registry. It runs `git`
// with explicit argument arrays (never a shell string), stages only paths
// inside the workspace directory, and never fabricates a Git identity.
// ---------------------------------------------------------------------------

export interface CommitWorkspaceChangesOptions {
  /** Absolute path of the workspace directory (the `git` cwd). */
  workspace: string;
  /**
   * Commit message. When empty (or whitespace only), a message is derived
   * from the changed file paths.
   */
  message?: string;
}

export type CommitWorkspaceChangesResult =
  | { status: 'committed'; hash: string; message: string; files: string[] }
  | { status: 'clean' }
  | { status: 'not-a-repository' }
  | { status: 'git-unavailable' };

// The same conservative Git environment as the read-only agent tools: no
// external diff drivers, no pager, and no optional locks.
const COMMIT_GIT_ENV = {
  GIT_EXTERNAL_DIFF: '',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};

// Conventional subject-line limit; longer derived messages fall back to a
// generic "Update N files" summary.
const MAX_SUBJECT_LENGTH = 72;

/** Extract changed paths from `git status --short` output ('XY PATH' lines). */
function changedPaths(statusOutput: string): string[] {
  const paths: string[] = [];
  for (const line of statusOutput.split('\n')) {
    if (line.length < 4) continue;
    // The two status letters are followed by a single space, then the path
    // ('?? ' for untracked files). Renames render as 'R  old -> new'; the
    // destination is the interesting half.
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    if (path.length > 0 && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function defaultCommitMessage(files: string[]): string {
  const subject = `Update ${files.join(', ')}`;
  return subject.length <= MAX_SUBJECT_LENGTH ? subject : `Update ${String(files.length)} files`;
}

/**
 * Stage and commit every change inside the workspace directory.
 *
 * Used by the user-invoked TUI `/commit` command; this is not an agent tool.
 */
export async function commitWorkspaceChanges(
  options: CommitWorkspaceChangesOptions,
): Promise<CommitWorkspaceChangesResult> {
  const availability = await detectGitAvailability();
  if (!availability.available) return { status: 'git-unavailable' };

  const status = await executeProcess(
    'git',
    [
      '--no-pager',
      '-c',
      'core.fsmonitor=false',
      'status',
      '--short',
      '--untracked-files=all',
      '--',
      '.',
    ],
    {
      cwd: options.workspace,
      timeoutMs: 30_000,
      maximumBufferBytes: 1_048_576,
      environment: COMMIT_GIT_ENV,
    },
  );
  if (status.exitCode !== 0) {
    if (/not a git repository/iu.test(status.stderr)) return { status: 'not-a-repository' };
    throw new Error(
      status.stderr.trim() || `git status failed (exit code ${String(status.exitCode)}).`,
    );
  }

  const files = changedPaths(status.stdout);
  if (files.length === 0) return { status: 'clean' };

  const message =
    options.message !== undefined && options.message.trim().length > 0
      ? options.message.trim()
      : defaultCommitMessage(files);

  const add = await executeProcess('git', ['add', '-A', '--', '.'], {
    cwd: options.workspace,
    timeoutMs: 30_000,
    maximumBufferBytes: 1_048_576,
    environment: COMMIT_GIT_ENV,
  });
  if (add.exitCode !== 0) {
    throw new Error(add.stderr.trim() || 'git add failed.');
  }

  const commit = await executeProcess('git', ['commit', '-m', message], {
    cwd: options.workspace,
    timeoutMs: 30_000,
    maximumBufferBytes: 1_048_576,
    environment: COMMIT_GIT_ENV,
  });
  if (commit.exitCode !== 0) {
    throw new Error(commit.stderr.trim() || 'git commit failed.');
  }

  const hashResult = await executeProcess('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: options.workspace,
    timeoutMs: 30_000,
    maximumBufferBytes: 1_048_576,
    environment: COMMIT_GIT_ENV,
  });
  if (hashResult.exitCode !== 0) {
    throw new Error(hashResult.stderr.trim() || 'Unable to resolve the new commit hash.');
  }

  return { status: 'committed', hash: hashResult.stdout.trim(), message, files };
}
