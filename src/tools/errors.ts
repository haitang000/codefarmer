export type ToolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_IGNORED'
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_FILE'
  | 'PATH_NOT_DIRECTORY'
  | 'FILE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'PATCH_INVALID'
  | 'PATCH_CONFLICT'
  | 'TRANSACTION_FAILED'
  | 'APPROVAL_DENIED'
  | 'PLAN_MODE_FORBIDDEN'
  | 'COMMAND_BLOCKED'
  | 'COMMAND_TIMEOUT'
  | 'COMMAND_FAILED'
  | 'GIT_FAILED'
  | 'GIT_UNAVAILABLE'
  | 'TOOL_NOT_FOUND'
  | 'HOOK_BLOCKED'
  | 'SKILL_NOT_FOUND'
  | 'SKILLS_UNAVAILABLE'
  | 'PATH_OUTSIDE_SKILL'
  | 'TOOL_FAILED';

export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolError';
    this.code = code;
  }
}

export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ToolError('TOOL_FAILED', message, {
    cause: error instanceof Error ? error : undefined,
  });
}
