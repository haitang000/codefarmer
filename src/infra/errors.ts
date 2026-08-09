import type { JsonValue } from '../types.js';

export const EXIT_CODES = {
  success: 0,
  failure: 1,
  configuration: 2,
  approval: 3,
  authentication: 4,
  interrupted: 130,
} as const;

export type AppErrorCode =
  | 'CONFIG_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'PROVIDER_ERROR'
  | 'TOOL_ERROR'
  | 'APPROVAL_ERROR'
  | 'CONFLICT_ERROR'
  | 'PERSISTENCE_ERROR'
  | 'WORKSPACE_ERROR'
  | 'INTERRUPTED'
  | 'INTERNAL_ERROR';

export interface AppErrorOptions {
  code?: AppErrorCode;
  exitCode?: number;
  cause?: unknown;
  details?: JsonValue;
  retryable?: boolean;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly exitCode: number;
  readonly details: JsonValue | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.exitCode = options.exitCode ?? EXIT_CODES.failure;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      exitCode: this.exitCode,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, {
      ...options,
      code: 'CONFIG_ERROR',
      exitCode: EXIT_CODES.configuration,
    });
  }
}

export class AuthenticationError extends AppError {
  constructor(
    message = 'OpenAI authentication failed. Check OPENAI_API_KEY.',
    options: Omit<AppErrorOptions, 'code' | 'exitCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'AUTHENTICATION_ERROR',
      exitCode: EXIT_CODES.authentication,
    });
  }
}

export class ProviderError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'PROVIDER_ERROR' });
  }
}

export class ToolError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'TOOL_ERROR' });
  }
}

export class ApprovalError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, {
      ...options,
      code: 'APPROVAL_ERROR',
      exitCode: EXIT_CODES.approval,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'CONFLICT_ERROR' });
  }
}

export class PersistenceError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'PERSISTENCE_ERROR' });
  }
}

export class WorkspaceError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'WORKSPACE_ERROR' });
  }
}

export class InterruptedError extends AppError {
  constructor(
    message = 'Operation interrupted.',
    options: Omit<AppErrorOptions, 'code' | 'exitCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'INTERRUPTED',
      exitCode: EXIT_CODES.interrupted,
    });
  }
}

export function toAppError(
  error: unknown,
  fallbackMessage = 'An unexpected error occurred.',
): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError(error.message || fallbackMessage, { cause: error });
  }
  if (typeof error === 'string' && error.length > 0) return new AppError(error);
  return new AppError(fallbackMessage);
}

export function formatAppError(error: unknown, verbose = false): string {
  const appError = toAppError(error);
  if (verbose && appError.stack) return appError.stack;
  return `[${appError.code}] ${appError.message}`;
}
