import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import { PersistenceError } from './errors.js';

export interface WriteJsonOptions {
  mode?: number;
  spaces?: number;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string, schema?: ZodType<T>): Promise<T> {
  try {
    const text = await readFile(filePath, 'utf8');
    const value: unknown = JSON.parse(text);
    return schema ? schema.parse(value) : (value as T);
  } catch (error) {
    throw new PersistenceError(`Unable to read JSON file: ${filePath}`, {
      cause: error,
    });
  }
}

export async function readJsonFileIfExists<T>(
  filePath: string,
  schema?: ZodType<T>,
): Promise<T | undefined> {
  if (!(await fileExists(filePath))) return undefined;
  return readJsonFile(filePath, schema);
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  const serialized = `${JSON.stringify(value, null, options.spaces ?? 2)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await mkdir(directory, { recursive: true });
    handle = await open(tempPath, 'wx', options.mode ?? 0o600);
    await handle.writeFile(serialized, 'utf8');
    // Deliberately no fsync: the atomic rename already guards against torn
    // files, and syncing every session save stalls the agent loop on Windows.
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new PersistenceError(`Unable to write JSON file: ${filePath}`, {
      cause: error,
    });
  }
}

export class JsonStore<T> {
  constructor(
    readonly filePath: string,
    private readonly schema?: ZodType<T>,
  ) {}

  read(): Promise<T> {
    return readJsonFile(this.filePath, this.schema);
  }

  readIfExists(): Promise<T | undefined> {
    return readJsonFileIfExists(this.filePath, this.schema);
  }

  write(value: T, options?: WriteJsonOptions): Promise<void> {
    return writeJsonAtomic(this.filePath, value, options);
  }

  async update(
    updater: (current: T | undefined) => T | Promise<T>,
    options?: WriteJsonOptions,
  ): Promise<T> {
    const next = await updater(await this.readIfExists());
    if (this.schema) this.schema.parse(next);
    await this.write(next, options);
    return next;
  }

  async delete(): Promise<void> {
    try {
      await rm(this.filePath, { force: true });
    } catch (error) {
      throw new PersistenceError(`Unable to delete JSON file: ${this.filePath}`, {
        cause: error,
      });
    }
  }
}
