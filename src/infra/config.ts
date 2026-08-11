import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PROVIDER_IDS } from '../types.js';
import type {
  ApprovalPolicy,
  CodeFarmerConfig,
  LogLevel,
  ReasoningEffort,
  ReasoningSummary,
  TextVerbosity,
  ProviderId,
} from '../types.js';
import { isProviderId, providerPreset } from '../providers/catalog.js';
import { ConfigError } from './errors.js';
import { getAppPaths } from './paths.js';
import { fileExists, writeJsonAtomic } from './persistence.js';

export const DEFAULT_IGNORED_PATHS = [
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
] as const;

export const DEFAULT_CONFIG: Readonly<CodeFarmerConfig> = {
  provider: 'openai',
  model: 'gpt-5.6-sol',
  baseURL: 'https://api.openai.com/v1',
  reasoning: 'low',
  verbosity: 'low',
  reasoningSummary: 'none',
  approval: 'ask',
  stream: true,
  store: true,
  logLevel: 'info',
  maxAgentTurns: 12,
  maxOutputTokens: 2_048,
  maxFileSizeBytes: 1_048_576,
  maxToolOutputBytes: 12_288,
  commandTimeoutMs: 120_000,
  ignoredPaths: [...DEFAULT_IGNORED_PATHS],
};

const baseURLSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  }, 'baseURL must be an HTTP(S) URL without credentials, query, or fragment')
  .transform((value) => value.replace(/\/+$/u, ''));

const configShape = {
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(1),
  baseURL: baseURLSchema,
  reasoning: z.enum(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']),
  verbosity: z.enum(['low', 'medium', 'high']),
  reasoningSummary: z.enum(['none', 'auto', 'concise', 'detailed']),
  approval: z.enum(['ask', 'auto', 'read-only']),
  stream: z.boolean(),
  store: z.literal(true),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  maxAgentTurns: z.number().int().min(1).max(100),
  maxOutputTokens: z.number().int().min(128).max(100_000),
  maxFileSizeBytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024),
  maxToolOutputBytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
  commandTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1_000),
  ignoredPaths: z.array(z.string().min(1)).max(1_000),
};

export const codeFarmerConfigSchema = z.object(configShape).strict();

export const configFileSchema = codeFarmerConfigSchema
  .partial()
  .extend({ $schema: z.string().optional() })
  .strict();

export const configSchema = codeFarmerConfigSchema;

export type ConfigFile = Partial<CodeFarmerConfig> & { $schema?: string };
export type ConfigOverrides = Partial<CodeFarmerConfig>;

export interface LoadConfigOptions {
  cwd?: string;
  cli?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
  projectConfigPath?: string;
  userConfigPath?: string;
}

export interface LoadedConfig {
  config: CodeFarmerConfig;
  projectConfigPath: string;
  userConfigPath: string;
  loadedProjectConfig: boolean;
  loadedUserConfig: boolean;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function parseBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new ConfigError(`${name} must be a boolean (true/false).`);
}

function parseInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw new ConfigError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError(`${name} is outside the supported integer range.`);
  }
  return parsed;
}

function parseStore(value: string | undefined): true | undefined {
  const parsed = parseBoolean('CODEFARMER_STORE', value);
  if (parsed === false) {
    throw new ConfigError('CODEFARMER_STORE=false is not supported in v1 session mode.');
  }
  return parsed;
}

function parseIgnoredPaths(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
        throw new Error('not a string array');
      }
      return parsed;
    } catch (error) {
      throw new ConfigError(
        'CODEFARMER_IGNORED_PATHS must be a JSON string array or a comma-separated list.',
        { cause: error },
      );
    }
  }
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): ConfigOverrides {
  const provider = env.CODEFARMER_PROVIDER;
  const providerConfig: Partial<Pick<CodeFarmerConfig, 'model' | 'baseURL'>> =
    provider !== undefined && isProviderId(provider) ? providerDefaults(provider) : {};
  return definedOnly({
    provider: provider as ProviderId | undefined,
    model: env.CODEFARMER_MODEL ?? providerConfig.model,
    baseURL: env.CODEFARMER_BASE_URL ?? env.OPENAI_BASE_URL ?? providerConfig.baseURL,
    reasoning: env.CODEFARMER_REASONING as ReasoningEffort | undefined,
    verbosity: env.CODEFARMER_VERBOSITY as TextVerbosity | undefined,
    reasoningSummary: env.CODEFARMER_REASONING_SUMMARY as ReasoningSummary | undefined,
    approval: env.CODEFARMER_APPROVAL as ApprovalPolicy | undefined,
    stream: parseBoolean('CODEFARMER_STREAM', env.CODEFARMER_STREAM),
    store: parseStore(env.CODEFARMER_STORE),
    logLevel: env.CODEFARMER_LOG_LEVEL as LogLevel | undefined,
    maxAgentTurns: parseInteger('CODEFARMER_MAX_AGENT_TURNS', env.CODEFARMER_MAX_AGENT_TURNS),
    maxOutputTokens: parseInteger(
      'CODEFARMER_MAX_OUTPUT_TOKENS',
      env.CODEFARMER_MAX_OUTPUT_TOKENS,
    ),
    maxFileSizeBytes: parseInteger(
      'CODEFARMER_MAX_FILE_SIZE_BYTES',
      env.CODEFARMER_MAX_FILE_SIZE_BYTES,
    ),
    maxToolOutputBytes: parseInteger(
      'CODEFARMER_MAX_TOOL_OUTPUT_BYTES',
      env.CODEFARMER_MAX_TOOL_OUTPUT_BYTES,
    ),
    commandTimeoutMs: parseInteger(
      'CODEFARMER_COMMAND_TIMEOUT_MS',
      env.CODEFARMER_COMMAND_TIMEOUT_MS,
    ),
    ignoredPaths: parseIgnoredPaths(env.CODEFARMER_IGNORED_PATHS),
  }) as ConfigOverrides;
}

/** Return the built-in endpoint/model pair for a provider selected by setup. */
export function providerDefaults(provider: ProviderId): Pick<CodeFarmerConfig, 'model' | 'baseURL'> {
  const preset = providerPreset(provider);
  return { model: preset.defaultModel, baseURL: preset.defaultBaseURL };
}

async function readConfigFile(filePath: string): Promise<ConfigFile | undefined> {
  if (!(await fileExists(filePath))) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return configFileSchema.parse(parsed) as ConfigFile;
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
            .join('; ')
        : error instanceof Error
          ? error.message
          : 'unknown parsing error';
    throw new ConfigError(`Invalid configuration file ${filePath}: ${message}`, {
      cause: error,
    });
  }
}

function withoutSchema(config: ConfigFile | undefined): ConfigOverrides {
  if (!config) return {};
  const values = { ...config };
  delete values.$schema;
  return definedOnly(values);
}

function validateMergedConfig(value: unknown): CodeFarmerConfig {
  try {
    return codeFarmerConfigSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
        .join('; ');
      throw new ConfigError(`Invalid CodeFarmer configuration: ${details}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function loadConfigDetails(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const appPaths = getAppPaths();
  const projectConfigPath = path.resolve(
    options.projectConfigPath ?? path.join(cwd, 'codefarmer.config.json'),
  );
  const userConfigPath = path.resolve(options.userConfigPath ?? appPaths.userConfigFile);
  const [userConfig, projectConfig] = await Promise.all([
    readConfigFile(userConfigPath),
    readConfigFile(projectConfigPath),
  ]);
  const userOverrides = withoutSchema(userConfig);
  const projectOverrides = withoutSchema(projectConfig);
  const environmentOverrides = configFromEnvironment(options.env);
  const cliOverrides = definedOnly(options.cli ?? {});
  const selectedProvider =
    cliOverrides.provider ??
    environmentOverrides.provider ??
    projectOverrides.provider ??
    userOverrides.provider ??
    DEFAULT_CONFIG.provider;
  const selectedDefaults = isProviderId(selectedProvider)
    ? providerDefaults(selectedProvider)
    : {};

  const config = validateMergedConfig({
    ...DEFAULT_CONFIG,
    ...selectedDefaults,
    ignoredPaths: [...DEFAULT_CONFIG.ignoredPaths],
    ...userOverrides,
    ...projectOverrides,
    ...environmentOverrides,
    ...cliOverrides,
  });

  return {
    config,
    projectConfigPath,
    userConfigPath,
    loadedProjectConfig: projectConfig !== undefined,
    loadedUserConfig: userConfig !== undefined,
  };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<CodeFarmerConfig> {
  return (await loadConfigDetails(options)).config;
}

export async function writeConfigFile(filePath: string, config: ConfigFile): Promise<void> {
  let validated: ConfigFile;
  try {
    validated = configFileSchema.parse(config) as ConfigFile;
  } catch (error) {
    throw new ConfigError('Refusing to write an invalid CodeFarmer configuration.', {
      cause: error,
    });
  }
  await writeJsonAtomic(filePath, validated);
}
