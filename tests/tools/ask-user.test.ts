import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createToolRegistry } from '../../src/tools/registry.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-ask-'));
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

describe('ask_user', () => {
  it('returns ASK_UNAVAILABLE without an interactive handler', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace });
    const result = await registry.execute({
      callId: 'ask-1',
      name: 'ask_user',
      arguments: { question: 'Which approach?', options: ['A', 'B'] },
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'ASK_UNAVAILABLE' },
    });
  });

  it('returns the selected option from the handler', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({
      workspace,
      askUser: (request) =>
        Promise.resolve({
          cancelled: false,
          selected: request.options[1] ?? 'B',
          index: 1,
        }),
    });
    const result = await registry.execute({
      callId: 'ask-2',
      name: 'ask_user',
      arguments: { question: 'Pick one', options: ['left', 'right'] },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('right');
    expect(result.data).toMatchObject({ cancelled: false, selected: 'right', index: 1 });
  });

  it('records a cancellation without failing the tool', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({
      workspace,
      askUser: () => Promise.resolve({ cancelled: true }),
    });
    const result = await registry.execute({
      callId: 'ask-3',
      name: 'ask_user',
      arguments: { question: 'Pick one', options: ['left', 'right'] },
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ cancelled: true });
  });
});
