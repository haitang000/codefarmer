import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createToolRegistry } from '../../src/tools/registry.js';
import {
  buildRipgrepArgs,
  parseRipgrepJson,
  setRipgrepAvailableForTests,
} from '../../src/tools/search-rg.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-rg-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  setRipgrepAvailableForTests(undefined);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ripgrep argument builder and JSON parser', () => {
  it('passes the query after -- and globs as values, not flags', () => {
    const args = buildRipgrepArgs({
      query: '-hidden',
      target: 'src',
      caseSensitive: false,
      glob: '-n.ts',
      maxResults: 20,
      maxFileBytes: 1024,
    });
    expect(args).toContain('--no-config');
    expect(args).toContain('-F');
    expect(args).toContain('-i');
    expect(args).toContain('--glob=-n.ts');
    const separator = args.indexOf('--');
    expect(separator).toBeGreaterThan(0);
    expect(args[separator + 1]).toBe('-hidden');
    expect(args[separator + 2]).toBe('src');
  });

  it('parses match events and every submatch column', () => {
    const stdout = [
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/app.ts' },
          lines: { text: 'foo bar foo\n' },
          line_number: 1,
          submatches: [{ start: 0 }, { start: 8 }],
        },
      }),
      '{"type":"summary","data":{}}',
      'not-json',
    ].join('\n');
    expect(parseRipgrepJson(stdout, 10)).toEqual([
      { path: 'src/app.ts', line: 1, column: 1, text: 'foo bar foo' },
      { path: 'src/app.ts', line: 1, column: 9, text: 'foo bar foo' },
    ]);
  });
});

describe('search_text ripgrep integration', () => {
  it('falls back to the JavaScript scanner when ripgrep is unavailable', async () => {
    setRipgrepAvailableForTests(false);
    const workspace = await temporaryWorkspace();
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const needle = 1;\n');
    const registry = await createToolRegistry({ workspace });
    const searched = await registry.execute({
      callId: 'js-fallback',
      name: 'search_text',
      arguments: { query: 'needle', path: 'src/app.ts', regex: null },
    });
    expect(searched.success).toBe(true);
    expect(searched.data).toMatchObject({ engine: 'js', count: 1 });
    expect(searched.output).toContain('src/app.ts:1:14');
  });
});
