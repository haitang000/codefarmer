import { describe, expect, it, vi } from 'vitest';

import { extractCommitMessage, TuiInteractionBridge } from '../src/tui/runtime.js';
import {
  completeTuiCommand,
  parseTuiCommand,
  TUI_HELP,
  tuiCommandAdvice,
} from '../src/tui/types.js';

describe('TUI command parser', () => {
  it('keeps normal input as a prompt and recognises local commands', () => {
    expect(parseTuiCommand('  inspect this workspace  ')).toEqual({
      kind: 'prompt',
      value: 'inspect this workspace',
    });
    expect(parseTuiCommand('/sessions')).toEqual({ kind: 'sessions' });
    expect(parseTuiCommand('/init')).toEqual({ kind: 'init' });
    expect(parseTuiCommand('/skills')).toEqual({ kind: 'skills' });
    expect(parseTuiCommand('/skill docs')).toEqual({ kind: 'skill', ref: 'docs' });
    expect(parseTuiCommand('/skill off')).toEqual({ kind: 'skill', ref: 'off' });
    expect(parseTuiCommand('/status')).toEqual({ kind: 'status' });
    expect(parseTuiCommand('/stats')).toEqual({ kind: 'stats' });
    expect(parseTuiCommand('/context')).toEqual({ kind: 'context' });
    expect(parseTuiCommand('/ctx')).toEqual({ kind: 'context' });
    expect(parseTuiCommand('/compact')).toEqual({ kind: 'compact' });
    expect(parseTuiCommand('/effort')).toEqual({ kind: 'effort' });
    expect(parseTuiCommand('/reasoning')).toEqual({ kind: 'effort' });
    expect(parseTuiCommand('/plan')).toEqual({ kind: 'plan', value: '' });
    expect(parseTuiCommand('/plan ON')).toEqual({ kind: 'plan', value: 'on' });
    expect(parseTuiCommand('/plan off')).toEqual({ kind: 'plan', value: 'off' });
    expect(parseTuiCommand('/push')).toEqual({ kind: 'push', args: [] });
    expect(parseTuiCommand('/push origin main')).toEqual({
      kind: 'push',
      args: ['origin', 'main'],
    });
    expect(parseTuiCommand('/config')).toEqual({ kind: 'config' });
    expect(parseTuiCommand('/doctor')).toEqual({ kind: 'doctor' });
    expect(parseTuiCommand('/resume session-1')).toEqual({
      kind: 'resume',
      id: 'session-1',
    });
    expect(parseTuiCommand('/delete session-2')).toEqual({
      kind: 'delete-session',
      id: 'session-2',
    });
    expect(parseTuiCommand('/exit')).toEqual({ kind: 'quit' });
    expect(TUI_HELP).toContain('/undo');
    expect(TUI_HELP).toContain('/context');
    expect(TUI_HELP).toContain('/stats');
    expect(TUI_HELP).toContain('/compact');
    expect(TUI_HELP).toContain('/effort');
    expect(TUI_HELP).toContain('/plan');
    expect(TUI_HELP).toContain('/init');
    expect(TUI_HELP).toContain('/push');
    expect(TUI_HELP).toContain('/skills');
  });

  it('returns unknown commands without discarding their arguments', () => {
    expect(parseTuiCommand('/missing one two')).toEqual({
      kind: 'unknown',
      name: 'missing',
      args: ['one', 'two'],
    });
  });

  it('provides a unique advice suffix and accepts it with completion', () => {
    expect(tuiCommandAdvice('/hel')).toBe('p');
    expect(completeTuiCommand('/hel')).toBe('/help');
    expect(tuiCommandAdvice('/')).toBe('help');
    expect(tuiCommandAdvice('/st')).toBe('');
    expect(tuiCommandAdvice('/in')).toBe('it');
    expect(tuiCommandAdvice('/pu')).toBe('sh');
    expect(tuiCommandAdvice('/s')).toBe('');
    expect(tuiCommandAdvice('/help ')).toBe('');
    expect(completeTuiCommand('inspect this workspace')).toBe('inspect this workspace');
  });
});

describe('TUI interaction bridge', () => {
  it('denies approval before the UI attaches and then delegates to its handler', async () => {
    const bridge = new TuiInteractionBridge();
    const request = { kind: 'patch' as const, title: 'modify: file.ts', detail: 'diff' };

    await expect(bridge.approvalPrompt(request)).resolves.toBe(false);
    bridge.setApprovalHandler(() => Promise.resolve(true));
    await expect(bridge.approvalPrompt(request)).resolves.toBe(true);
  });

  it('converts tool hooks into UI events', async () => {
    const bridge = new TuiInteractionBridge();
    const handler = vi.fn();
    bridge.setToolEventHandler(handler);

    await bridge.toolHooks.onToolStart?.({
      callId: 'call-1',
      name: 'read_file',
      arguments: { path: 'src/index.ts' },
    });

    expect(handler).toHaveBeenCalledWith({
      type: 'tool_start',
      call: {
        callId: 'call-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'src/index.ts' }),
      },
    });
  });
});

describe('commit message extraction', () => {
  it('keeps a plain commit message and collapses blank-line runs', () => {
    expect(extractCommitMessage('fix: resolve the login redirect\n\n- clear the stale token')).toBe(
      'fix: resolve the login redirect\n\n- clear the stale token',
    );
    expect(extractCommitMessage('feat: add status command\n\n\n\n\n- first\n\n\n- second')).toBe(
      'feat: add status command\n\n- first\n\n- second',
    );
  });

  it('prefers a fenced code block and trims surrounding prose', () => {
    const reply = [
      'Here is the summary I came up with:',
      '```',
      'refactor: extract the git status check',
      '',
      '- reuse the inspection in the TUI commit flow',
      '```',
      'Let me know if you want any changes.',
    ].join('\n');
    expect(extractCommitMessage(reply)).toBe(
      'refactor: extract the git status check\n\n- reuse the inspection in the TUI commit flow',
    );
  });

  it('returns an empty string for unusable replies', () => {
    expect(extractCommitMessage('   \n  ')).toBe('');
    expect(extractCommitMessage('```\n\n```')).toBe('');
  });
});
