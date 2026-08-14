import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { normaliseLanguage } from '../types.js';
import type {
  ApprovalPolicy,
  CodeFarmerConfig,
  CustomEndpoint,
  CustomEndpointInput,
  LogLevel,
  ReasoningEffort,
  ReasoningSummary,
  TextVerbosity,
} from '../types.js';
import { findCustomEndpoint, isProviderId, providerPreset } from '../providers/catalog.js';
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
  language: 'en',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  baseURL: 'https://api.openai.com/v1',
  customEndpoints: [],
  reasoning: 'high',
  verbosity: 'low',
  reasoningSummary: 'none',
  approval: 'ask',
  stream: true,
  store: true,
  logLevel: 'info',
  maxAgentTurns: 12,
  maxFileSizeBytes: 1_048_576,
  maxToolOutputBytes: 12_288,
  commandTimeoutMs: 120_000,
  autoCompact: false,
  autoCompactMinMessages: 40,
  autoCompactMinChars: 100_000,
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

const customEndpointIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u,
    'id 只能包含字母、数字、下划线或连字符，且不能以 - 或 _ 开头',
  );

const customEndpointSchema = z.object({
  id: customEndpointIdSchema,
  label: z.string().trim().min(1).max(64).optional(),
  baseURL: baseURLSchema,
  model: z.string().trim().min(1),
  apiKeyEnv: z.string().trim().min(1).max(128).optional(),
  apiKeyOptional: z.boolean().optional(),
});

/** Inline `provider` object form; `id` defaults to the baseURL hostname. */
const customEndpointInputSchema = customEndpointSchema.extend({
  id: customEndpointIdSchema.optional(),
});

const configShape = {
  language: z.enum(['en', 'zh-CN']),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  baseURL: baseURLSchema,
  customEndpoints: z.array(customEndpointSchema).max(50),
  reasoning: z.enum(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']),
  verbosity: z.enum(['low', 'medium', 'high']),
  reasoningSummary: z.enum(['none', 'auto', 'concise', 'detailed']),
  approval: z.enum(['ask', 'auto', 'read-only']),
  stream: z.boolean(),
  store: z.literal(true),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  maxAgentTurns: z.number().int().min(1).max(100),
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
  autoCompact: z.boolean(),
  autoCompactMinMessages: z.number().int().min(2).max(100_000),
  autoCompactMinChars: z
    .number()
    .int()
    .min(1_000)
    .max(50 * 1024 * 1024),
  ignoredPaths: z.array(z.string().min(1)).max(1_000),
  budgetUsd: z.number().positive().max(1_000_000).optional(),
};

/** Validate a merged configuration, including cross-field provider references. */
export const codeFarmerConfigSchema = z
  .object(configShape)
  .strict()
  .superRefine((config, ctx) => {
    const endpoints = config.customEndpoints;
    const ids = new Set<string>();
    for (const endpoint of endpoints) {
      if (isProviderId(endpoint.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['customEndpoints'],
          message: `id "${endpoint.id}" 与内置 Provider 重名`,
        });
      }
      if (ids.has(endpoint.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['customEndpoints'],
          message: `customEndpoints 中 id "${endpoint.id}" 重复`,
        });
      }
      ids.add(endpoint.id);
    }
    if (!isProviderId(config.provider) && !ids.has(config.provider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `provider "${config.provider}" 未定义；请使用内置 provider，或在 customEndpoints / provider 中定义该端点`,
      });
    }
  });

/**
 * Per-field validation for individual config files. Cross-field and
 * cross-file references (provider ↔ customEndpoints) are only checked on the
 * merged configuration, because a single file is just a partial view.
 */
export const configFileSchema = z
  .object({ ...configShape, provider: z.union([z.string().trim().min(1), customEndpointInputSchema]) })
  .partial()
  .extend({ $schema: z.string().optional() })
  .strict();

export const configSchema = codeFarmerConfigSchema;

export type ConfigFile = Partial<Omit<CodeFarmerConfig, 'provider'>> & {
  provider?: string | CustomEndpointInput;
  $schema?: string;
};
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

function parseNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive number.`);
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

function parseLanguage(value: string | undefined): CodeFarmerConfig['language'] | undefined {
  if (value === undefined) return undefined;
  const language = normaliseLanguage(value);
  if (language === undefined) throw new ConfigError('CODEFARMER_LANGUAGE must be en or zh-CN.');
  return language;
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
    language: parseLanguage(env.CODEFARMER_LANGUAGE),
    provider,
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
    autoCompact: parseBoolean('CODEFARMER_AUTO_COMPACT', env.CODEFARMER_AUTO_COMPACT),
    autoCompactMinMessages: parseInteger(
      'CODEFARMER_AUTO_COMPACT_MIN_MESSAGES',
      env.CODEFARMER_AUTO_COMPACT_MIN_MESSAGES,
    ),
    autoCompactMinChars: parseInteger(
      'CODEFARMER_AUTO_COMPACT_MIN_CHARS',
      env.CODEFARMER_AUTO_COMPACT_MIN_CHARS,
    ),
    ignoredPaths: parseIgnoredPaths(env.CODEFARMER_IGNORED_PATHS),
    budgetUsd: parseNumber('CODEFARMER_BUDGET_USD', env.CODEFARMER_BUDGET_USD),
  }) as ConfigOverrides;
}

/**
 * Return the endpoint/model pair for a provider selected by setup or CLI.
 * Built-in providers use their catalog defaults; custom endpoints use the
 * `baseURL`/`model` from their `customEndpoints` entry.
 */
export function providerDefaults(
  provider: string,
  customEndpoints?: readonly CustomEndpoint[],
): Pick<CodeFarmerConfig, 'model' | 'baseURL'> {
  const preset = providerPreset(provider, customEndpoints);
  return { model: preset.defaultModel, baseURL: preset.defaultBaseURL };
}

/** Merge custom endpoints from user, project, and CLI layers; later layers win per id. */
function mergeCustomEndpoints(
  groups: readonly (readonly CustomEndpoint[] | undefined)[],
): CustomEndpoint[] {
  const byId = new Map<string, CustomEndpoint>();
  for (const group of groups) {
    for (const endpoint of group ?? []) byId.set(endpoint.id, endpoint);
  }
  return [...byId.values()];
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

/** Derive a stable endpoint id from a baseURL hostname (e.g. `localhost`). */
export function endpointIdFromBaseURL(baseURL: string): string {
  try {
    const id = new URL(baseURL)
      .hostname.replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '');
    return id.length > 0 ? id.slice(0, 64) : 'custom';
  } catch {
    return 'custom';
  }
}

/**
 * Turn an inline `provider` object into a string id plus a registered
 * `customEndpoints` entry, so the rest of the runtime only sees string ids.
 */
function resolveInlineProvider(
  config: ConfigFile,
): Omit<ConfigFile, 'provider'> & { provider?: string } {
  const provider = config.provider;
  if (provider === undefined || typeof provider === 'string') {
    return config as Omit<ConfigFile, 'provider'> & { provider?: string };
  }
  const id = provider.id ?? endpointIdFromBaseURL(provider.baseURL);
  const endpointFields = definedOnly(provider) as Omit<CustomEndpoint, 'id'>;
  const resolved: CustomEndpoint = { ...endpointFields, id };
  return {
    ...config,
    provider: id,
    customEndpoints: [
      ...(config.customEndpoints ?? []).filter((entry) => entry.id !== id),
      resolved,
    ],
  };
}

function withoutSchema(config: ConfigFile | undefined): ConfigOverrides {
  if (!config) return {};
  const values: Omit<ConfigFile, 'provider'> & { provider?: string; $schema?: string } = {
    ...resolveInlineProvider(config),
  };
  delete values.$schema;
  return definedOnly(values);
}

function validateMergedConfig(value: unknown): CodeFarmerConfig {
  try {
    const parsed = codeFarmerConfigSchema.parse(value);
    const { budgetUsd, ...rest } = parsed;
    return {
      ...rest,
      // exactOptionalPropertyTypes: zod can produce `budgetUsd: undefined`,
      // which must be dropped rather than kept as an explicit undefined.
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      customEndpoints: parsed.customEndpoints.map(
        (endpoint) => definedOnly(endpoint) as CustomEndpoint,
      ),
    };
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
  const customEndpoints = mergeCustomEndpoints([
    userOverrides.customEndpoints,
    projectOverrides.customEndpoints,
    cliOverrides.customEndpoints,
  ]);
  const selectedProvider =
    cliOverrides.provider ??
    environmentOverrides.provider ??
    projectOverrides.provider ??
    userOverrides.provider ??
    DEFAULT_CONFIG.provider;
  const selectedDefaults =
    isProviderId(selectedProvider) ||
    findCustomEndpoint(selectedProvider, customEndpoints) !== undefined
      ? providerDefaults(selectedProvider, customEndpoints)
      : {};

  const config = validateMergedConfig({
    ...DEFAULT_CONFIG,
    ...selectedDefaults,
    ignoredPaths: [...DEFAULT_CONFIG.ignoredPaths],
    ...userOverrides,
    ...projectOverrides,
    ...environmentOverrides,
    ...cliOverrides,
    customEndpoints,
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
