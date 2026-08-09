import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REDACTED,
  cleanupOldLogs,
  createLogger,
  dailyLogFile,
  redactLogValue,
} from '../src/infra/logger.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-logger-'));
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

describe('logger', () => {
  it('recursively redacts credentials, authorization, and file bodies', () => {
    const value = redactLogValue(
      {
        authorization: 'Bearer visible-token',
        nested: {
          apiKey: 'secret-value',
          content: 'const secret = true',
          safe: 'keep-me',
        },
      },
      ['secret-value'],
    );

    expect(value).toEqual({
      authorization: REDACTED,
      nested: {
        apiKey: REDACTED,
        content: REDACTED,
        safe: 'keep-me',
      },
    });
  });

  it('writes sanitized JSONL records to the daily log', async () => {
    const logDirectory = await temporaryDirectory();
    const now = new Date('2026-07-17T12:00:00.000Z');
    const logger = await createLogger({
      logDirectory,
      now,
      terminal: false,
      secrets: ['raw-secret-value'],
    });

    logger.info(
      {
        password: 'raw-secret-value',
        nested: { token: 'raw-secret-value', safe: 'visible' },
        diff: '+ private source',
      },
      'request used Bearer abc.def and raw-secret-value',
    );
    logger.flush();

    const text = await readFile(dailyLogFile(logDirectory, now), 'utf8');
    expect(text).not.toContain('raw-secret-value');
    expect(text).not.toContain('abc.def');
    expect(text).not.toContain('private source');
    expect(text).toContain('visible');
    expect(text).toContain(REDACTED);
  });

  it('removes only expired CodeFarmer daily logs', async () => {
    const logDirectory = await temporaryDirectory();
    const expired = path.join(logDirectory, 'codefarmer-2026-06-01.jsonl');
    const retained = path.join(logDirectory, 'codefarmer-2026-07-10.jsonl');
    const unrelated = path.join(logDirectory, 'application.log');
    await Promise.all([
      writeFile(expired, 'old'),
      writeFile(retained, 'recent'),
      writeFile(unrelated, 'unrelated'),
    ]);

    await cleanupOldLogs(logDirectory, 14, new Date('2026-07-17T12:00:00.000Z'));

    await expect(readFile(expired, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(retained, 'utf8')).resolves.toBe('recent');
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('unrelated');
  });
});
