import { describe, expect, it, vi } from 'vitest';

import { PolicyApprovalController } from '../src/core/approval.js';

describe('PolicyApprovalController', () => {
  it('requires an interactive confirmation for protected commands under auto', async () => {
    const prompt = vi.fn(() => true);
    const controller = new PolicyApprovalController('auto', prompt, true);

    await expect(
      controller.request({
        kind: 'command',
        title: 'Push Git changes',
        detail: '["git", "push", "origin", "main"]',
        requireConfirmation: true,
      }),
    ).resolves.toBe(true);

    expect(prompt).toHaveBeenCalledOnce();
  });

  it('rejects protected commands when an interactive confirmation is unavailable', async () => {
    const prompt = vi.fn(() => true);
    const controller = new PolicyApprovalController('auto', prompt, false);

    await expect(
      controller.request({
        kind: 'command',
        title: 'Push Git changes',
        detail: '["git", "push"]',
        requireConfirmation: true,
      }),
    ).resolves.toBe(false);

    expect(prompt).not.toHaveBeenCalled();
  });
});
