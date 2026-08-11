import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ApprovalDecision, ApprovalRequest, ApprovalScope } from './approval.js';
import { canonicalWorkspace, getAppPaths, workspaceHash } from '../infra/paths.js';
import { readJsonFileIfExists, writeJsonAtomic } from '../infra/persistence.js';

export interface PermissionGrant {
  kind: ApprovalRequest['kind'];
  pattern: string;
  createdAt: string;
}

interface PermissionFile {
  version: 1;
  grants: PermissionGrant[];
}

function normalisePattern(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '').toLowerCase();
}

/** Derives a stable, bounded permission pattern from the structured approval detail. */
export function permissionPattern(request: ApprovalRequest): string {
  if (request.permissionKey !== undefined) return normalisePattern(request.permissionKey);
  if (request.kind === 'command') {
    try {
      const command = JSON.parse(request.detail) as unknown;
      if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
        return `command:${command.join('\u0000')}`.toLowerCase();
      }
    } catch {
      // Fall back to the displayed detail for older callers.
    }
    return `command:${request.detail}`.toLowerCase();
  }
  const marker = request.title.indexOf(':');
  return `file:${normalisePattern(marker < 0 ? request.title : request.title.slice(marker + 1))}`;
}

function matches(grant: PermissionGrant, request: ApprovalRequest): boolean {
  const pattern = permissionPattern(request);
  if (grant.kind !== request.kind) return false;
  if (grant.kind === 'command')
    return pattern === grant.pattern || pattern.startsWith(`${grant.pattern}\u0000`);
  return pattern === grant.pattern || pattern.startsWith(`${grant.pattern}/`);
}

/** Stores session-only and workspace-scoped approvals without weakening hard denials. */
export class PermissionStore {
  private readonly sessionGrants: PermissionGrant[] = [];
  private workspaceGrants: PermissionGrant[] = [];

  private constructor(
    public readonly workspace: string,
    private readonly filePath: string,
  ) {}

  public static async create(workspace: string): Promise<PermissionStore> {
    const canonical = await canonicalWorkspace(workspace);
    const appPaths = getAppPaths();
    const directory = path.join(appPaths.config, 'permissions');
    await mkdir(directory, { recursive: true });
    const store = new PermissionStore(
      canonical,
      path.join(directory, `${workspaceHash(canonical)}.json`),
    );
    const file = await readJsonFileIfExists<PermissionFile>(store.filePath);
    if (file?.version === 1 && Array.isArray(file.grants)) store.workspaceGrants = file.grants;
    return store;
  }

  public has(request: ApprovalRequest): boolean {
    return [...this.sessionGrants, ...this.workspaceGrants].some((grant) =>
      matches(grant, request),
    );
  }

  public async apply(request: ApprovalRequest, decision: ApprovalDecision): Promise<boolean> {
    if (!decision.approved) return false;
    const scope: ApprovalScope = decision.scope ?? 'once';
    if (scope === 'once' || request.requireConfirmation === true) return true;
    let pattern = permissionPattern(request);
    if (scope === 'workspace' && request.kind === 'patch') {
      const separator = pattern.lastIndexOf('/');
      if (separator > 'file:'.length) pattern = pattern.slice(0, separator);
    }
    const grant: PermissionGrant = {
      kind: request.kind,
      pattern,
      createdAt: new Date().toISOString(),
    };
    const target = scope === 'workspace' ? this.workspaceGrants : this.sessionGrants;
    if (!target.some((entry) => entry.kind === grant.kind && entry.pattern === grant.pattern))
      target.push(grant);
    if (scope === 'workspace')
      await writeJsonAtomic(this.filePath, { version: 1, grants: this.workspaceGrants });
    return true;
  }

  public clearSession(): void {
    this.sessionGrants.splice(0);
  }

  public grants(): { session: PermissionGrant[]; workspace: PermissionGrant[] } {
    return {
      session: this.sessionGrants.map((grant) => ({ ...grant })),
      workspace: this.workspaceGrants.map((grant) => ({ ...grant })),
    };
  }
}
