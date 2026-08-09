import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, configFromEnvironment, loadConfig } from '../src/infra/config.js';
import { ConfigError } from '../src/infra/errors.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-config-'));
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

describe('configuration', () => {
  it('uses documented defaults when no configuration files exist', async () => {
    const cwd = await temporaryDirectory();
    const config = await loadConfig({
      cwd,
      env: {},
      userConfigPath: path.join(cwd, 'missing-user.json'),
    });

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.maxAgentTurns).toBe(50);
    expect(config.commandTimeoutMs).toBe(120_000);
    expect(config.baseURL).toBe('https://api.openai.com/v1');
  });

  it('applies CLI > environment > project > user > defaults precedence', async () => {
    const cwd = await temporaryDirectory();
    const userConfigPath = path.join(cwd, 'user.json');
    const projectConfigPath = path.join(cwd, 'codefarmer.config.json');
    await writeFile(
      userConfigPath,
      JSON.stringify({
        model: 'user-model',
        baseURL: 'https://user.example/v1',
        maxAgentTurns: 7,
        logLevel: 'debug',
      }),
    );
    await writeFile(
      projectConfigPath,
      JSON.stringify({
        model: 'project-model',
        baseURL: 'https://project.example/v1',
        maxAgentTurns: 11,
        approval: 'auto',
      }),
    );

    const config = await loadConfig({
      cwd,
      userConfigPath,
      projectConfigPath,
      env: {
        CODEFARMER_MODEL: 'environment-model',
        CODEFARMER_BASE_URL: 'https://environment.example/v1/',
        CODEFARMER_MAX_AGENT_TURNS: '19',
      },
      cli: { model: 'cli-model', baseURL: 'http://localhost:8080/v1/' },
    });

    expect(config.model).toBe('cli-model');
    expect(config.baseURL).toBe('http://localhost:8080/v1');
    expect(config.maxAgentTurns).toBe(19);
    expect(config.approval).toBe('auto');
    expect(config.logLevel).toBe('debug');
    expect(config.reasoning).toBe('medium');
  });

  it('parses boolean, integer, and ignored-path environment values', () => {
    expect(
      configFromEnvironment({
        CODEFARMER_STREAM: 'off',
        CODEFARMER_STORE: '1',
        OPENAI_BASE_URL: 'https://gateway.example/v1',
        CODEFARMER_COMMAND_TIMEOUT_MS: '45000',
        CODEFARMER_IGNORED_PATHS: '["vendor/**","*.secret"]',
      }),
    ).toMatchObject({
      stream: false,
      store: true,
      baseURL: 'https://gateway.example/v1',
      commandTimeoutMs: 45_000,
      ignoredPaths: ['vendor/**', '*.secret'],
    });
  });

  it('rejects unknown fields, including persisted API keys', async () => {
    const cwd = await temporaryDirectory();
    const projectConfigPath = path.join(cwd, 'codefarmer.config.json');
    await writeFile(projectConfigPath, JSON.stringify({ apiKey: 'must-not-be-stored' }));

    await expect(
      loadConfig({
        cwd,
        env: {},
        projectConfigPath,
        userConfigPath: path.join(cwd, 'missing-user.json'),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('reports malformed environment values as configuration errors', () => {
    expect(() => configFromEnvironment({ CODEFARMER_STREAM: 'sometimes' })).toThrow(ConfigError);
    expect(() => configFromEnvironment({ CODEFARMER_MAX_FILE_SIZE_BYTES: '1.5' })).toThrow(
      ConfigError,
    );
    expect(() => configFromEnvironment({ CODEFARMER_STORE: 'false' })).toThrow(ConfigError);
  });

  it('rejects unsafe Base URLs', async () => {
    const cwd = await temporaryDirectory();
    for (const baseURL of [
      'ftp://example.com/v1',
      'https://user:password@example.com/v1',
      'https://example.com/v1?tenant=secret',
    ]) {
      await expect(
        loadConfig({
          cwd,
          env: {},
          cli: { baseURL },
          userConfigPath: path.join(cwd, 'missing-user.json'),
        }),
      ).rejects.toBeInstanceOf(ConfigError);
    }
  });
});
