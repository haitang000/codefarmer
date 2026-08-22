import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../src/tools/registry.js';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codefarmer-files-'));
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

describe('workspace file tools', () => {
  it('lists, reads, hashes, and searches text without exposing secrets', async () => {
    const workspace = await temporaryWorkspace();
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'hello.ts'), 'export const hello = "world";\n');
    await writeFile(path.join(workspace, '.env'), 'TOKEN=hidden\n');
    await writeFile(path.join(workspace, '.env.example'), 'TOKEN=\n');
    const registry = await createToolRegistry({ workspace });

    const listed = await registry.execute({
      callId: 'list-1',
      name: 'list_files',
      arguments: '{}',
    });
    expect(listed).toMatchObject({ callId: 'list-1', toolName: 'list_files', success: true });
    expect(listed.output).toContain('src/hello.ts');
    expect(listed.output).toContain('.env.example');
    expect(listed.output).not.toMatch(/(?:^|\n)\.env\t/u);

    const read = await registry.execute({
      callId: 'read-1',
      name: 'read_file',
      arguments: { path: 'src/hello.ts' },
    });
    expect(read.output).toContain('export const hello');
    expect(read.data).toMatchObject({
      sha256: createHash('sha256').update('export const hello = "world";\n').digest('hex'),
    });

    const searched = await registry.execute({
      callId: 'search-1',
      name: 'search_text',
      arguments: { query: 'HELLO', glob: '**/*.ts' },
    });
    expect(searched.success).toBe(true);
    expect(searched.output).toContain('src/hello.ts:1:14');
  });

  it('returns structured failures for malformed calls and oversized files', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'large.txt'), 'abcdef');
    const registry = await createToolRegistry({ workspace, maxFileBytes: 5 });

    const invalidJson = await registry.execute({
      callId: 'bad-json',
      name: 'read_file',
      arguments: '{',
    });
    expect(invalidJson).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGUMENT' },
    });

    const tooLarge = await registry.execute({
      callId: 'large',
      name: 'read_file',
      arguments: { path: 'large.txt' },
    });
    expect(tooLarge).toMatchObject({ success: false, error: { code: 'FILE_TOO_LARGE' } });
  });

  it('treats stringified null path arguments as the workspace root', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'note.txt'), 'hello\n');
    const registry = await createToolRegistry({ workspace });

    const listed = await registry.execute({
      callId: 'list-null',
      name: 'list_files',
      arguments: { path: 'null', maxDepth: null, maxResults: null },
    });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('note.txt');

    // Gateways stringify every JSON null into the literal text "null"; all
    // optional arguments must still parse instead of failing validation.
    const searched = await registry.execute({
      callId: 'search-null',
      name: 'search_text',
      arguments: {
        query: 'hello',
        path: 'null',
        glob: 'null',
        caseSensitive: 'null',
        maxResults: 'null',
      },
    });
    expect(searched.success).toBe(true);
    expect(searched.output).toContain('note.txt:1:1');
  });

  it('searches inside a single file when path points at a file', async () => {
    const workspace = await temporaryWorkspace();
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const needle = 1;\n');
    const registry = await createToolRegistry({ workspace });

    const searched = await registry.execute({
      callId: 'search-file',
      name: 'search_text',
      arguments: {
        query: 'needle',
        path: 'src/app.ts',
        glob: null,
        caseSensitive: null,
        maxResults: null,
      },
    });
    expect(searched.success).toBe(true);
    expect(searched.output).toContain('src/app.ts:1:14');
  });

  it('publishes strict-compatible schemas with every property required', async () => {
    const workspace = await temporaryWorkspace();
    const registry = await createToolRegistry({ workspace });

    for (const definition of registry.definitions) {
      // apply_patch intentionally offers two mutually exclusive shapes
      // (single-file fields vs the files array), so its top-level fields are
      // optional by design and validated in code.
      if (definition.name === 'apply_patch') continue;
      const properties = definition.inputSchema.properties;
      const required = definition.inputSchema.required;
      expect(required).toEqual(
        properties !== null && typeof properties === 'object' && !Array.isArray(properties)
          ? Object.keys(properties)
          : [],
      );
    }
  });

  it('clamps endLine beyond the end of the file instead of rejecting it', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'note.txt'), 'one\ntwo\nthree\n');
    const registry = await createToolRegistry({ workspace });

    // Models routinely guess the file length; asking for line 500 of a
    // three-line file should return what exists, not fail.
    const read = await registry.execute({
      callId: 'clamp-end',
      name: 'read_file',
      arguments: { path: 'note.txt', startLine: 2, endLine: 500 },
    });
    expect(read.success).toBe(true);
    expect(read.output).toBe('2|two\n3|three\n4|');
    expect(read.data).toMatchObject({ startLine: 2, endLine: 4 });
  });

  it('prefixes read_file lines with 1-based numbers', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'note.txt'), 'alpha\nbeta\n');
    const registry = await createToolRegistry({ workspace });

    const read = await registry.execute({
      callId: 'numbered',
      name: 'read_file',
      arguments: { path: 'note.txt', startLine: null, endLine: null },
    });
    expect(read.success).toBe(true);
    expect(read.output).toBe('1|alpha\n2|beta\n3|');
    expect(read.data).toMatchObject({ startLine: 1, endLine: 3, totalLines: 3 });
  });

  it('searches with a regular expression and reports every match on a line', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'src.ts'), 'foo bar foo\nFOO\n');
    const registry = await createToolRegistry({ workspace });

    const searched = await registry.execute({
      callId: 'search-regex',
      name: 'search_text',
      arguments: {
        query: 'foo',
        path: 'src.ts',
        glob: null,
        caseSensitive: null,
        maxResults: null,
        regex: null,
      },
    });
    expect(searched.success).toBe(true);
    expect(searched.output).toContain('src.ts:1:1:');
    expect(searched.output).toContain('src.ts:1:9:');
    expect(searched.output).toContain('src.ts:2:1:');
    expect(searched.data).toMatchObject({ count: 3 });

    const regexSearch = await registry.execute({
      callId: 'search-re',
      name: 'search_text',
      arguments: {
        query: 'fo+',
        path: 'src.ts',
        glob: null,
        caseSensitive: true,
        maxResults: null,
        regex: true,
      },
    });
    expect(regexSearch.success).toBe(true);
    expect(regexSearch.output).toContain('src.ts:1:1:');
    expect(regexSearch.output).not.toContain('src.ts:2:');

    const invalid = await registry.execute({
      callId: 'search-bad-re',
      name: 'search_text',
      arguments: { query: '(unclosed', regex: true },
    });
    expect(invalid).toMatchObject({ success: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('skips binary files while searching text', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'note.txt'), 'visible needle\n');
    await writeFile(path.join(workspace, 'blob.bin'), Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65]));
    await writeFile(path.join(workspace, 'picture.png'), 'needle in a png name only');
    const registry = await createToolRegistry({ workspace });

    const searched = await registry.execute({
      callId: 'search-binary',
      name: 'search_text',
      arguments: { query: 'needle', path: null, glob: null, caseSensitive: null, maxResults: null },
    });
    expect(searched.success).toBe(true);
    expect(searched.output).toContain('note.txt:1:');
    expect(searched.output).not.toContain('blob.bin');
    expect(searched.output).not.toContain('picture.png');
  });

  it('write_file creates and overwrites files behind the staleness guard', async () => {
    const workspace = await temporaryWorkspace();
    let mutation: unknown;
    const registry = await createToolRegistry({
      workspace,
      approve: () => true,
      onMutation: (value) => {
        mutation = value;
      },
    });

    const created = await registry.execute({
      callId: 'write-create',
      name: 'write_file',
      arguments: { path: 'fresh/hello.txt', content: 'hello\n', expectedSha256: null },
    });
    expect(created.success).toBe(true);
    expect(created.output).toBe('create: fresh/hello.txt (+1)');
    expect(mutation).toMatchObject({ operation: 'create', path: 'fresh/hello.txt' });

    const current = createHash('sha256').update('hello\n').digest('hex');
    const overwritten = await registry.execute({
      callId: 'write-overwrite',
      name: 'write_file',
      arguments: { path: 'fresh/hello.txt', content: 'goodbye\n', expectedSha256: current },
    });
    expect(overwritten.success).toBe(true);
    expect(overwritten.output).toBe('modify: fresh/hello.txt (+1 -1)');
    expect(await readFile(path.join(workspace, 'fresh/hello.txt'), 'utf8')).toBe('goodbye\n');

    const stale = await registry.execute({
      callId: 'write-stale',
      name: 'write_file',
      arguments: { path: 'fresh/hello.txt', content: 'sneaky\n', expectedSha256: current },
    });
    expect(stale).toMatchObject({ success: false, error: { code: 'PATCH_CONFLICT' } });
    expect(await readFile(path.join(workspace, 'fresh/hello.txt'), 'utf8')).toBe('goodbye\n');
  });
});
