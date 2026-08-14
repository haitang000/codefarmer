import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TodoStore } from '../../src/core/todos.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { renderTodos } from '../../src/tools/todo-write.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-todos-'));
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

describe('todo_write', () => {
  it('replaces the todo list and returns the rendered items', async () => {
    const workspace = await temporaryWorkspace();
    const todos = new TodoStore();
    const registry = await createToolRegistry({ workspace, todos });

    const result = await registry.execute({
      callId: 'todo-1',
      name: 'todo_write',
      arguments: {
        todos: [
          { content: 'Inspect the failing test', status: 'in_progress' },
          { content: 'Apply the fix', status: 'pending' },
        ],
      },
    });

    expect(result).toMatchObject({ callId: 'todo-1', toolName: 'todo_write', success: true });
    expect(result.output).toContain('[>] Inspect the failing test');
    expect(result.output).toContain('[ ] Apply the fix');
    expect(result.data).toMatchObject({ count: 2 });
    expect(todos.list()).toEqual([
      { content: 'Inspect the failing test', status: 'in_progress' },
      { content: 'Apply the fix', status: 'pending' },
    ]);
  });

  it('clears the list with an empty array', async () => {
    const workspace = await temporaryWorkspace();
    const todos = new TodoStore();
    todos.replace([{ content: 'done work', status: 'done' }]);
    const registry = await createToolRegistry({ workspace, todos });

    const result = await registry.execute({
      callId: 'todo-2',
      name: 'todo_write',
      arguments: { todos: [] },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('(no todos)');
    expect(todos.list()).toEqual([]);
  });

  it('rejects invalid items with structured errors', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace, todos: new TodoStore() });

    const badStatus = await registry.execute({
      callId: 'todo-3',
      name: 'todo_write',
      arguments: { todos: [{ content: 'task', status: 'nope' }] },
    });
    expect(badStatus).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGUMENT' },
    });

    const missing = await registry.execute({
      callId: 'todo-4',
      name: 'todo_write',
      arguments: {},
    });
    expect(missing).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('fails when todo tracking is not available in the runtime', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace });

    const result = await registry.execute({
      callId: 'todo-5',
      name: 'todo_write',
      arguments: { todos: [{ content: 'task', status: 'pending' }] },
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'TODO_UNAVAILABLE' },
    });
  });

  it('renders all status markers', () => {
    expect(
      renderTodos([
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'done' },
        { content: 'd', status: 'cancelled' },
      ]),
    ).toBe('[ ] a\n[>] b\n[x] c\n[-] d');
  });
});
