export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/**
 * In-memory, per-session todo list maintained by the agent through the
 * `todo_write` tool and inspected by the user through `/todos`. It is not
 * part of a SessionRecord: a fresh runtime starts with an empty list.
 */
export class TodoStore {
  private items: TodoItem[] = [];

  replace(items: TodoItem[]): TodoItem[] {
    this.items = items.map((item) => ({ content: item.content, status: item.status }));
    return this.list();
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ content: item.content, status: item.status }));
  }
}
