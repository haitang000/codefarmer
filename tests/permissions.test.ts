import { describe, expect, it } from 'vitest';

import { PermissionStore, permissionPattern } from '../src/core/permissions.js';
import type { ApprovalRequest } from '../src/core/approval.js';

describe('permissions', () => {
  it('normalises command patterns and keeps hard confirmation requests out of grants', () => {
    const request: ApprovalRequest = {
      kind: 'command',
      title: 'Run npm',
      detail: JSON.stringify(['npm', 'test']),
    };
    expect(permissionPattern(request)).toBe('command:npm\u0000test');
  });

  it('keeps session grants separate from workspace grants', async () => {
    const store = await PermissionStore.create(process.cwd());
    const request: ApprovalRequest = {
      kind: 'patch',
      title: 'modify: src/example.ts',
      detail: 'diff',
    };
    expect(store.has(request)).toBe(false);
    await store.apply(request, { approved: true, scope: 'session' });
    expect(store.has(request)).toBe(true);
    store.clearSession();
    expect(store.has(request)).toBe(false);
  });
});
