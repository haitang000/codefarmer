import type { TodoItem } from '../types.js';

export type { TodoItem, TodoStatus } from '../types.js';

/**
 * Session-scoped todo list maintained by the agent through `todo_write`.
 * When a session is available, changes are saved before they are acknowledged.
 */
export class TodoStore {
  private items: TodoItem[];

  public constructor(
    initial: TodoItem[] = [],
    private readonly persist?: (items: TodoItem[]) => Promise<void>,
  ) {
    this.items = initial.map((item) => ({ ...item }));
  }

  replace(items: TodoItem[]): TodoItem[] {
    this.items = items.map((item) => ({ content: item.content, status: item.status }));
    return this.list();
  }

  async replacePersisted(items: TodoItem[]): Promise<TodoItem[]> {
    const next = items.map((item) => ({ ...item }));
    await this.persist?.(next);
    this.items = next;
    return this.list();
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ content: item.content, status: item.status }));
  }
}
