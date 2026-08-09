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
    invalidArgument(
      'commit must be a revision such as HEAD or a commit hash, not an option.',
    );
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

