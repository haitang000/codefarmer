import type { ToolDefinition, ToolResult } from '../types.js';
import type { TodoItem, TodoStatus, TodoStore } from '../core/todos.js';
import { ToolError } from './errors.js';
import { successfulResult } from './output.js';
import type { ResolvedToolContext } from './types.js';

export const MAX_TODOS = 20;
export const MAX_TODO_CONTENT_CHARS = 200;
export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done', 'cancelled'];

export const todoWriteDefinition: ToolDefinition = {
  name: 'todo_write',
  description:
    'Replace the session todo list with the given items. Use it to track multi-step tasks; the list is shown to the user with /todos and persists for the session.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete todo list; an empty array clears it.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1, maxLength: MAX_TODO_CONTENT_CHARS },
            status: { type: 'string', enum: [...TODO_STATUSES] },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
        maxItems: MAX_TODOS,
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
};

function parseTodo(entry: unknown, index: number): TodoItem {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ToolError('INVALID_ARGUMENT', `todos[${String(index)}] must be an object.`);
  }
  const record = entry as Record<string, unknown>;
  const content = record.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `todos[${String(index)}].content must be a non-empty string.`,
    );
  }
  if (content.length > MAX_TODO_CONTENT_CHARS) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `todos[${String(index)}].content exceeds ${String(MAX_TODO_CONTENT_CHARS)} characters.`,
    );
  }
  const status = record.status;
  if (typeof status !== 'string' || !TODO_STATUSES.includes(status as TodoStatus)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `todos[${String(index)}].status must be one of: ${TODO_STATUSES.join(', ')}.`,
    );
  }
  return { content, status: status as TodoStatus };
}

export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '(no todos)';
  const statusMarker: Record<TodoStatus, string> = {
    pending: '[ ]',
    in_progress: '[>]',
    done: '[x]',
    cancelled: '[-]',
  };
  return todos.map((item) => `${statusMarker[item.status]} ${item.content}`).join('\n');
}

export function writeTodos(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
): Promise<ToolResult> {
  const store: TodoStore | undefined = context.todos;
  if (store === undefined) {
    throw new ToolError('TODO_UNAVAILABLE', 'Todo tracking is not available in this runtime.');
  }
  const todos = arguments_.todos;
  if (!Array.isArray(todos)) {
    throw new ToolError('INVALID_ARGUMENT', 'todos must be an array.');
  }
  if (todos.length > MAX_TODOS) {
    throw new ToolError('INVALID_ARGUMENT', `At most ${String(MAX_TODOS)} todos are allowed.`);
  }
  const items = todos.map((entry, index) => parseTodo(entry, index));
  const list = store.replace(items);
  return Promise.resolve(
    successfulResult(callId, 'todo_write', renderTodos(list), {
      data: { count: list.length },
    }),
  );
}
