import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveSessionTitle, SessionStore } from '../src/core/session-store.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-session-store-'));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Point the platform user directories at a scratch root for the duration of a
 * callback, mirroring the environment isolation used by the CLI tests.
 */
async function withIsolatedEnv<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      HOME: root,
      USERPROFILE: root,
      APPDATA: path.join(root, 'appdata'),
      LOCALAPPDATA: path.join(root, 'localappdata'),
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
      XDG_DATA_HOME: path.join(root, 'xdg-data'),
      XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
      XDG_STATE_HOME: path.join(root, 'xdg-state'),
    });
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('deriveSessionTitle', () => {
  it('keeps a short single-line prompt as-is', () => {
    expect(deriveSessionTitle('Fix the build')).toBe('Fix the build');
  });

  it('uses only the first line of a multi-line prompt', () => {
    expect(deriveSessionTitle('First line\nsecond line\nthird')).toBe('First line');
  });

  it('collapses surrounding and inner whitespace', () => {
    expect(deriveSessionTitle('   a   b\t c  \nignored')).toBe('a b c');
  });

  it('truncates long prompts to 60 characters with an ellipsis', () => {
    const long = 'x'.repeat(100);
    const title = deriveSessionTitle(long);
    expect(title).toHaveLength(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to a placeholder for empty or whitespace-only prompts', () => {
    expect(deriveSessionTitle('')).toBe('未命名会话');
    expect(deriveSessionTitle('   \n\t ')).toBe('未命名会话');
  });
});

describe('SessionStore titles', () => {
  it('derives a title from the first user message only', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    await withIsolatedEnv(environmentRoot, async () => {
      const store = await SessionStore.create(workspace);
      const session = await store.createSession('test-provider', 'test-model');

      expect(session.title).toBeUndefined();

      await store.appendMessage(session, 'user', 'Refactor the login flow');
      expect(session.title).toBe('Refactor the login flow');
      expect(session.titleSource).toBe('automatic');

      await store.appendMessage(session, 'assistant', 'Here is the plan.');
      expect(session.title).toBe('Refactor the login flow');

      await store.appendMessage(session, 'user', 'Also update the tests');
      expect(session.title).toBe('Refactor the login flow');

      const persisted = await store.get(session.id);
      expect(persisted.title).toBe('Refactor the login flow');
    });
  });

  it('does not override an existing title when more messages arrive', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    await withIsolatedEnv(environmentRoot, async () => {
      const store = await SessionStore.create(workspace);
      const session = await store.createSession('test-provider', 'test-model');
      await store.appendMessage(session, 'user', 'first');
      await store.rename(session.id, 'Custom title');
      // Rename reloads the record from disk, so re-fetch like a CLI caller
      // would before appending more messages.
      const reloaded = await store.get(session.id);
      await store.appendMessage(reloaded, 'user', 'another prompt');
      expect((await store.get(session.id)).title).toBe('Custom title');
    });
  });

  it('renames a session and persists the trimmed title', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    await withIsolatedEnv(environmentRoot, async () => {
      const store = await SessionStore.create(workspace);
      const session = await store.createSession('test-provider', 'test-model');

      const renamed = await store.rename(session.id, '  Sprint 12 cleanup  ');
      expect(renamed.title).toBe('Sprint 12 cleanup');
      expect(renamed.titleSource).toBe('custom');
      expect((await store.get(session.id)).title).toBe('Sprint 12 cleanup');
    });
  });

  it('rejects empty titles and invalid or missing session ids', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    await withIsolatedEnv(environmentRoot, async () => {
      const store = await SessionStore.create(workspace);
      const session = await store.createSession('test-provider', 'test-model');

      await expect(store.rename(session.id, '   ')).rejects.toThrow('会话标题不能为空');
      await expect(store.rename('../evil', 'title')).rejects.toThrow('无效的会话 ID');
      await expect(store.rename('missing-session', 'title')).rejects.toThrow();
    });
  });
});

describe('SessionStore empty sessions', () => {
  it('does not persist a session until it has at least one message', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    await withIsolatedEnv(environmentRoot, async () => {
      const store = await SessionStore.create(workspace);
      const session = await store.createSession('test-provider', 'test-model');

      // Created but never used: readable in memory, invisible on disk and in
      // the session list.
      expect((await store.get(session.id)).id).toBe(session.id);
      expect(await store.list()).toEqual([]);

      // Saves of an empty session still do not create a file.
      await store.save(session);
      store.saveQueued(session);
      await store.flush();
      expect(await store.list()).toEqual([]);

      // The first message materialises the session.
      await store.appendMessage(session, 'user', 'Fix the build');
      expect(await store.list()).toHaveLength(1);
      expect((await store.get(session.id)).messages).toHaveLength(1);
    });
  });

  it('keeps in-memory updates (rename, status) of an empty session', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    await withIsolatedEnv(environmentRoot, async () => {
      const store = await SessionStore.create(workspace);
      const session = await store.createSession('test-provider', 'test-model');

      await store.rename(session.id, 'Draft');
      await store.setStatus(session, 'cancelled');

      const pending = await store.get(session.id);
      expect(pending.title).toBe('Draft');
      expect(pending.status).toBe('cancelled');
      expect(await store.list()).toEqual([]);
    });
  });

  it('removes an empty session from memory on delete', async () => {
    const workspace = await temporaryDirectory();
    const environmentRoot = await temporaryDirectory();
    await withIsolatedEnv(environmentRoot, async () => {
      const store = await SessionStore.create(workspace);
      const session = await store.createSession('test-provider', 'test-model');

      await store.delete(session.id);
      await expect(store.get(session.id)).rejects.toThrow();
    });
  });
});
