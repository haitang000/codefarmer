import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAppPaths } from '../src/infra/paths.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('getAppPaths', () => {
  it('resolves the current HOME each time on macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('HOME', path.join(path.parse(process.cwd()).root, 'first-home'));

    const first = getAppPaths();

    vi.stubEnv('HOME', path.join(path.parse(process.cwd()).root, 'second-home'));
    const second = getAppPaths();

    expect(first.data).toBe(
      path.join(
        path.parse(process.cwd()).root,
        'first-home',
        'Library',
        'Application Support',
        'codefarmer',
      ),
    );
    expect(second.data).toBe(
      path.join(
        path.parse(process.cwd()).root,
        'second-home',
        'Library',
        'Application Support',
        'codefarmer',
      ),
    );
  });
});
