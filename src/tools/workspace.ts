import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { ToolError } from './errors.js';

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'node_modules',
  'bower_components',
  'coverage',
  'dist',
  'build',
  'out',
  'target',
]);

const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.crt',
  '.cer',
  '.der',
]);

export interface ResolveOptions {
  kind?: 'any' | 'file' | 'directory';
  allowIgnored?: boolean;
}

function normaliseForComparison(value: string): string {
  const normalised = path.resolve(value);
  return process.platform === 'win32' ? normalised.toLowerCase() : normalised;
}

export function isPathInside(root: string, candidate: string): boolean {
  const comparableRoot = normaliseForComparison(root);
  const comparableCandidate = normaliseForComparison(candidate);
  const relative = path.relative(comparableRoot, comparableCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isIgnoredRelativePath(relativePath: string): boolean {
  const portable = relativePath.replaceAll('\\', '/');
  const segments = portable.split('/').filter(Boolean);
  if (segments.some((segment) => IGNORED_DIRECTORY_NAMES.has(segment.toLowerCase()))) {
    return true;
  }

  const fileName = (segments.at(-1) ?? '').toLowerCase();
  if (fileName === '.env.example') return false;
  if (SENSITIVE_FILE_NAMES.has(fileName)) return true;
  if (fileName.startsWith('.env.')) return true;
  return SENSITIVE_EXTENSIONS.has(path.extname(fileName));
}

function assertRelativePath(relativePath: string): void {
  if (relativePath.includes('\0')) {
    throw new ToolError('INVALID_ARGUMENT', 'Paths cannot contain NUL bytes.');
  }
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/u.test(relativePath)) {
    throw new ToolError(
      'PATH_OUTSIDE_WORKSPACE',
      `Only workspace-relative paths are allowed: ${relativePath}`,
    );
  }
}

export class WorkspaceGuard {
  readonly root: string;
  private readonly customIgnore: Ignore;

  private constructor(root: string, customIgnore: Ignore) {
    this.root = root;
    this.customIgnore = customIgnore;
  }

  static async create(workspace: string, ignoredPaths: string[] = []): Promise<WorkspaceGuard> {
    const absolute = path.resolve(workspace);
    let resolved: string;
    try {
      resolved = await realpath(absolute);
    } catch (error) {
      throw new ToolError('PATH_NOT_FOUND', `Workspace does not exist: ${absolute}`, {
        cause: error as Error,
      });
    }

    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new ToolError('PATH_NOT_DIRECTORY', `Workspace is not a directory: ${absolute}`);
    }
    let customIgnore: Ignore;
    try {
      customIgnore = ignore().add(ignoredPaths);
    } catch (error) {
      throw new ToolError('INVALID_ARGUMENT', 'ignoredPaths contains an invalid pattern.', {
        cause: error as Error,
      });
    }
    return new WorkspaceGuard(resolved, customIgnore);
  }

  toRelative(absolutePath: string): string {
    const relative = path.relative(this.root, absolutePath);
    return relative === '' ? '.' : relative.split(path.sep).join('/');
  }

  isIgnored(relativePath: string): boolean {
    if (isIgnoredRelativePath(relativePath)) return true;
    const portable = relativePath.replaceAll('\\', '/').replace(/^\.\//u, '');
    return portable !== '' && portable !== '.' && this.customIgnore.ignores(portable);
  }

  private lexicalCandidate(relativePath: string, allowIgnored: boolean): string {
    assertRelativePath(relativePath);
    const candidate = path.resolve(this.root, relativePath);
    if (!isPathInside(this.root, candidate)) {
      throw new ToolError('PATH_OUTSIDE_WORKSPACE', `Path escapes the workspace: ${relativePath}`);
    }

    const relative = this.toRelative(candidate);
    if (!allowIgnored && this.isIgnored(relative)) {
      throw new ToolError('PATH_IGNORED', `Path is ignored by the safety policy: ${relative}`);
    }
    return candidate;
  }

  async resolveExisting(relativePath: string, options: ResolveOptions = {}): Promise<string> {
    const candidate = this.lexicalCandidate(relativePath, options.allowIgnored ?? false);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      throw new ToolError('PATH_NOT_FOUND', `Path does not exist: ${relativePath}`, {
        cause: error as Error,
      });
    }

    if (!isPathInside(this.root, resolved)) {
      throw new ToolError(
        'PATH_OUTSIDE_WORKSPACE',
        `Symbolic link points outside the workspace: ${relativePath}`,
      );
    }

    const info = await stat(resolved);
    if (options.kind === 'file' && !info.isFile()) {
      throw new ToolError('PATH_NOT_FILE', `Path is not a file: ${relativePath}`);
    }
    if (options.kind === 'directory' && !info.isDirectory()) {
      throw new ToolError('PATH_NOT_DIRECTORY', `Path is not a directory: ${relativePath}`);
    }
    return resolved;
  }

  async resolveForWrite(relativePath: string): Promise<{ path: string; exists: boolean }> {
    const candidate = this.lexicalCandidate(relativePath, false);
    if (candidate === this.root) {
      throw new ToolError('PATH_NOT_FILE', 'The workspace root cannot be written as a file.');
    }

    let candidateInfo;
    try {
      candidateInfo = await lstat(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new ToolError('PATH_NOT_FOUND', `Cannot inspect path: ${relativePath}`, {
          cause: error as Error,
        });
      }
    }
    if (candidateInfo !== undefined) {
      const info = candidateInfo;
      if (info.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = await realpath(candidate);
        } catch (error) {
          throw new ToolError(
            'PATH_NOT_FOUND',
            `Symbolic link target does not exist: ${relativePath}`,
            {
              cause: error as Error,
            },
          );
        }
        if (!isPathInside(this.root, resolved)) {
          throw new ToolError(
            'PATH_OUTSIDE_WORKSPACE',
            `Symbolic link points outside the workspace: ${relativePath}`,
          );
        }
      }
      const resolved = await this.resolveExisting(relativePath, { kind: 'file' });
      return { path: resolved, exists: true };
    }

    const requestedParent = path.dirname(candidate);
    let existingAncestor = requestedParent;
    for (;;) {
      try {
        await lstat(existingAncestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ToolError('PATH_NOT_FOUND', 'Cannot inspect a parent directory.', {
            cause: error as Error,
          });
        }
        const next = path.dirname(existingAncestor);
        if (next === existingAncestor || !isPathInside(this.root, next)) {
          throw new ToolError(
            'PATH_OUTSIDE_WORKSPACE',
            `Path escapes the workspace: ${relativePath}`,
          );
        }
        existingAncestor = next;
      }
    }
    const resolvedAncestor = await realpath(existingAncestor);
    const ancestorInfo = await stat(resolvedAncestor);
    if (!ancestorInfo.isDirectory()) {
      throw new ToolError('PATH_NOT_DIRECTORY', 'An existing path component is not a directory.');
    }
    if (!isPathInside(this.root, resolvedAncestor)) {
      throw new ToolError(
        'PATH_OUTSIDE_WORKSPACE',
        `Parent directory for the new file is outside the workspace: ${relativePath}`,
      );
    }
    const missingSuffix = path.relative(existingAncestor, requestedParent);
    const finalPath = path.join(resolvedAncestor, missingSuffix, path.basename(candidate));
    if (!isPathInside(this.root, finalPath)) {
      throw new ToolError('PATH_OUTSIDE_WORKSPACE', `Path escapes the workspace: ${relativePath}`);
    }
    return { path: finalPath, exists: false };
  }

  async prepareParentForWrite(targetPath: string): Promise<string> {
    if (!isPathInside(this.root, targetPath)) {
      throw new ToolError('PATH_OUTSIDE_WORKSPACE', 'Write target escapes the workspace.');
    }
    const parent = path.dirname(targetPath);
    await mkdir(parent, { recursive: true });
    const resolvedParent = await realpath(parent);
    if (!isPathInside(this.root, resolvedParent)) {
      throw new ToolError(
        'PATH_OUTSIDE_WORKSPACE',
        'Created parent resolves outside the workspace.',
      );
    }
    return path.join(resolvedParent, path.basename(targetPath));
  }
}
