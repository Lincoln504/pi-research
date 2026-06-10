/**
 * Configuration Module
 *
 * Source of truth: .env file in the extension directory.
 * The /research-config TUI is a friendly editor for that file.
 * process.env values override the file (useful for CI / one-off overrides).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

// Get the directory where this extension is installed
const __filename = fileURLToPath(import.meta.url);
const EXTENSION_DIR = path.dirname(__filename);

/**
 * Validates configuration schema using TypeBox.
 * This provides runtime validation and TypeScript types from the same source.
 */
export const ConfigSchema = Type.Object({
  /** Per-researcher timeout in milliseconds (default: 300000, range: 3-30 min) */
  RESEARCHER_TIMEOUT_MS: Type.Number({ minimum: 180000, maximum: 1800000, default: 300000 }),
  /** Maximum number of concurrent researcher processes (default: 3, range: 1-5) */
  MAX_CONCURRENT_RESEARCHERS: Type.Number({ minimum: 1, maximum: 5, default: 3 }),
  /** Maximum number of retries for a failed researcher (default: 2, range: 0-5) */
  RESEARCHER_MAX_RETRIES: Type.Number({ minimum: 0, maximum: 5, default: 2 }),
  /** Base delay between retries in milliseconds (default: 2000, range: 100-10000) */
  RESEARCHER_MAX_RETRY_DELAY_MS: Type.Number({ minimum: 100, maximum: 10000, default: 2000 }),
  /** Target depth for recursive research (default: 1, range: 1-3) */
  DEFAULT_RESEARCH_DEPTH: Type.Number({ minimum: 1, maximum: 3, default: 1 }),
  /** Number of batches to allow for a single scrape tool call (default: 2, 0=unlimited) */
  MAX_SCRAPE_BATCHES: Type.Number({ minimum: 0, maximum: 99, default: 2 }),
  /** Number of parallel browser pool workers (default: 4, range: 1-10) */
  WORKER_THREADS: Type.Number({ minimum: 1, maximum: 10, default: 4 }),
  /** Number of concurrent tasks per pool worker process (default: 2, range: 1-10) */
  WORKER_CONCURRENCY: Type.Number({ minimum: 1, maximum: 10, default: 2 }),
  /** Whether the local knowledge store is enabled (default: false) */
  LOCAL_KNOWLEDGE_STORE_ENABLED: Type.Boolean({ default: false }),
  /** Whether the global knowledge store is enabled (default: true) */
  GLOBAL_KNOWLEDGE_STORE_ENABLED: Type.Boolean({ default: true }),
  /** Embedding model to use for the knowledge store */
  EMBEDDING_MODEL: Type.String({ default: 'Xenova/all-MiniLM-L6-v2' }),
  /** Hardware backend for embeddings: 'webgpu' or 'cpu' */
  EMBEDDING_DEVICE: Type.Union([Type.Literal('webgpu'), Type.Literal('cpu')], { default: 'webgpu' }),
  /** Timeout for scraping operations in milliseconds (default: 15000, range: 5-120 seconds) */
  SCRAPE_TIMEOUT_MS: Type.Number({ minimum: 5000, maximum: 120000, default: 15000 }),
  /** How long to keep documents in the knowledge store before eviction (default: 30 days) */
  KNOWLEDGE_STORE_CACHE_TTL_DAYS: Type.Number({ minimum: 1, maximum: 365, default: 30 }),
  /** Timeout for embedding model initialization (default: 300000ms) */
  EMBEDDING_MODEL_INIT_TIMEOUT_MS: Type.Number({ minimum: 10000, maximum: 600000, default: 300000 }),
  /** Max fraction of context window to use for initial scrape context (default: 0.15) */
  MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: Type.Number({ minimum: 0.05, maximum: 1.0, default: 0.15 }),
  /** Estimated tokens per scrape result for planning (default: 2500) */
  AVG_TOKENS_PER_SCRAPE: Type.Number({ minimum: 500, maximum: 10000, default: 2500 }),
  /** Maximum number of concurrent scrapes (default: 3) */
  MAX_CONCURRENT_SCRAPES: Type.Number({ minimum: 1, maximum: 20, default: 3 }),
  /** Health check timeout in milliseconds (default: 10000ms) */
  HEALTH_CHECK_TIMEOUT_MS: Type.Number({ minimum: 2000, maximum: 120000, default: 10000 }),
  /** Default timeout for browser page operations like search (default: 45000ms) */
  SEARCH_TIMEOUT_MS: Type.Number({ minimum: 5000, maximum: 120000, default: 45000 }),
  /** TUI refresh debounce in milliseconds (default: 100ms) */
  TUI_REFRESH_DEBOUNCE_MS: Type.Number({ minimum: 0, maximum: 1000, default: 100 }),
  /** Timeout for individual browser tasks (default: 10000ms) */
  BROWSER_TASK_TIMEOUT_MS: Type.Number({ minimum: 2000, maximum: 120000, default: 10000 }),
  /** LLM Model override for all research sub-tasks: researchers, coordinator, evaluator, and knowledge synthesis.
   *  Format: provider/model-id (e.g. google/gemini-2.0-flash-001) or just model-id.
   *  When set, this overrides ctx.model for researcher sub-agents and the knowledge synthesis background LLM.
   *  The coordinator and evaluator continue to use the caller's model unless explicitly overridden here.
   */
  RESEARCH_MODEL: Type.Optional(Type.String()),
  /** Explicit directory for the knowledge store database (overrides default) */
  KNOWLEDGE_STORE_DIR: Type.Optional(Type.String()),
  /** Whether to automatically export a markdown research report to disk at the end (default: false) */
  RESEARCH_REPORT_EXPORT_ENABLED: Type.Boolean({ default: false }),
  /** Enable debug/verbose logging (writes INFO+DEBUG to log file). (default: true) */
  DEBUG: Type.Boolean({ default: true }),
});

export type Config = Static<typeof ConfigSchema>;

/** Default configuration values extracted from schema */
export const DEFAULTS: Config = Value.Create(ConfigSchema);

// ============================================================================
// Env-file persistence
// ============================================================================

export function getGlobalEnvFilePath(): string {
  return path.join(EXTENSION_DIR, '.env');
}

export function getLocalEnvFilePath(): string {
  return path.resolve(process.cwd(), '.pi-research.env');
}

/**
 * Returns the active database directory.
 */
export function getDbDir(): string {
  const config = getConfig();
  if (config.KNOWLEDGE_STORE_DIR) {
    return path.isAbsolute(config.KNOWLEDGE_STORE_DIR) 
      ? config.KNOWLEDGE_STORE_DIR 
      : path.resolve(process.cwd(), config.KNOWLEDGE_STORE_DIR);
  }
  const dbDir = path.resolve(EXTENSION_DIR, '..', 'knowledge_db');
  return path.isAbsolute(dbDir) ? dbDir : path.resolve(process.cwd(), dbDir);
}

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).replace(/\r$/, '');
    if (key) out[key] = val;
  }
  return out;
}

function loadEnvFile(): Record<string, string> {
  const merged: Record<string, string> = {};
  
  // 1. Global defaults
  try {
    const globalPath = getGlobalEnvFilePath();
    if (fs.existsSync(globalPath)) {
      Object.assign(merged, parseDotEnv(fs.readFileSync(globalPath, 'utf-8')));
    }
  } catch (err) {
    logger.warn('[config] Failed to read global env file:', err);
  }

  // 2. Local overrides
  try {
    const localPath = getLocalEnvFilePath();
    if (fs.existsSync(localPath)) {
      Object.assign(merged, parseDotEnv(fs.readFileSync(localPath, 'utf-8')));
    }
  } catch (err) {
    logger.warn('[config] Failed to read local env file:', err);
  }

  return merged;
}

/**
 * Write config back to env file.
 * Automatically selects between local and global based on project presence.
 */
export function saveConfig(config: Config): void {
  const isProject = fs.existsSync(path.resolve(process.cwd(), '.git')) || 
                    fs.existsSync(path.resolve(process.cwd(), 'package.json'));
  
  const p = isProject ? getLocalEnvFilePath() : getGlobalEnvFilePath();
  
  const newValues: Record<string, string> = {
    PI_RESEARCH_TIMEOUT_MS: String(config.RESEARCHER_TIMEOUT_MS),
    PI_RESEARCH_MAX_RESEARCHERS: String(config.MAX_CONCURRENT_RESEARCHERS),
    PI_RESEARCH_MAX_RETRIES: String(config.RESEARCHER_MAX_RETRIES),
    PI_RESEARCH_RETRY_DELAY_MS: String(config.RESEARCHER_MAX_RETRY_DELAY_MS),
    PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: String(config.HEALTH_CHECK_TIMEOUT_MS ?? DEFAULTS.HEALTH_CHECK_TIMEOUT_MS),
    PI_RESEARCH_SEARCH_TIMEOUT_MS: String(config.SEARCH_TIMEOUT_MS),
    PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS: String(config.TUI_REFRESH_DEBOUNCE_MS),
    PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: String(config.DEFAULT_RESEARCH_DEPTH),
    PI_RESEARCH_MAX_SCRAPE_BATCHES: String(config.MAX_SCRAPE_BATCHES),
    PI_RESEARCH_WORKER_THREADS: String(config.WORKER_THREADS),
    PI_RESEARCH_WORKER_CONCURRENCY: String(config.WORKER_CONCURRENCY),
    PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED: String(config.LOCAL_KNOWLEDGE_STORE_ENABLED),
    PI_RESEARCH_GLOBAL_KNOWLEDGE_ENABLED: String(config.GLOBAL_KNOWLEDGE_STORE_ENABLED),
    PI_RESEARCH_EMBEDDING_MODEL: config.EMBEDDING_MODEL,
    PI_RESEARCH_EMBEDDING_DEVICE: config.EMBEDDING_DEVICE,
    PI_RESEARCH_SCRAPE_TIMEOUT_MS: String(config.SCRAPE_TIMEOUT_MS),
    PI_RESEARCH_CACHE_TTL_DAYS: String(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
    PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS: String(config.EMBEDDING_MODEL_INIT_TIMEOUT_MS),
    PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: String(config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING),
    PI_RESEARCH_AVG_TOKENS_PER_SCRAPE: String(config.AVG_TOKENS_PER_SCRAPE),
    PI_RESEARCH_MAX_CONCURRENT_SCRAPES: String(config.MAX_CONCURRENT_SCRAPES),
    PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS: String(config.BROWSER_TASK_TIMEOUT_MS),
    ...(config.RESEARCH_MODEL ? { PI_RESEARCH_MODEL: config.RESEARCH_MODEL } : {}),
    ...(config.KNOWLEDGE_STORE_DIR ? { PI_RESEARCH_KNOWLEDGE_DIR: config.KNOWLEDGE_STORE_DIR } : {}),
    PI_RESEARCH_REPORT_EXPORT_ENABLED: String(config.RESEARCH_REPORT_EXPORT_ENABLED),
    PI_RESEARCH_DEBUG: String(config.DEBUG),
  };

  try {
    let lines: string[] = [];
    if (fs.existsSync(p)) {
      lines = fs.readFileSync(p, 'utf-8').split('\n');
    } else {
      lines = [
        '# pi-research configuration',
        '',
      ];
    }

    const updatedKeys = new Set<string>();
    const outLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        outLines.push(line);
        continue;
      }

      const eq = line.indexOf('=');
      if (eq < 1) {
        outLines.push(line);
        continue;
      }

      const key = line.slice(0, eq).trim();
      if (newValues[key] !== undefined) {
        outLines.push(`${key}=${newValues[key]}`);
        updatedKeys.add(key);
      } else {
        outLines.push(line);
      }
    }

    for (const [key, val] of Object.entries(newValues)) {
      // FIX (#33): Skip prototype pollution keys
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (!updatedKeys.has(key) && val !== '') {
        if (outLines.length > 0 && outLines[outLines.length - 1]?.trim() !== '') {
          outLines.push('');
        }
        outLines.push(`${key}=${val}`);
        updatedKeys.add(key);
      }
    }

    // Atomic write: write to temp file then rename (crash-safe)
    const tmpPath = `${p}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, outLines.join('\n'), 'utf-8');
    try {
      fs.renameSync(tmpPath, p);
    } catch (renameErr) {
      // fs.renameSync fails on Windows if target exists (NTFS). Fall back to copy+delete.
      if (process.platform === 'win32') {
        fs.copyFileSync(tmpPath, p);
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      } else {
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
        throw renameErr;
      }
    }
  } catch (err) {
    logger.error(`[config] Failed to write config to ${p}:`, err);
    throw err;
  }
}

// ============================================================================
// Internal State
// ============================================================================

let currentConfig: Config | null = null;

/**
 * Internal factory for creating a configuration object from env.
 * Primarily used for testing.
 */
export function createConfig(env: Record<string, string | undefined>, processEnv: Record<string, string | undefined>): Config {
  const e = { ...env, ...processEnv };

  const raw = {
    RESEARCHER_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_TIMEOUT_MS', DEFAULTS.RESEARCHER_TIMEOUT_MS),
    MAX_CONCURRENT_RESEARCHERS: parseEnvNumber(e, 'PI_RESEARCH_MAX_RESEARCHERS', DEFAULTS.MAX_CONCURRENT_RESEARCHERS),
    RESEARCHER_MAX_RETRIES: parseEnvNumber(e, 'PI_RESEARCH_MAX_RETRIES', DEFAULTS.RESEARCHER_MAX_RETRIES),
    RESEARCHER_MAX_RETRY_DELAY_MS: parseEnvNumber(e, 'PI_RESEARCH_RETRY_DELAY_MS', DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS),
    DEFAULT_RESEARCH_DEPTH: parseEnvNumber(e, 'PI_RESEARCH_DEFAULT_RESEARCH_DEPTH', DEFAULTS.DEFAULT_RESEARCH_DEPTH),
    MAX_SCRAPE_BATCHES: parseEnvNumber(e, 'PI_RESEARCH_MAX_SCRAPE_BATCHES', DEFAULTS.MAX_SCRAPE_BATCHES),
    WORKER_THREADS: parseEnvNumber(e, 'PI_RESEARCH_WORKER_THREADS', DEFAULTS.WORKER_THREADS),
    WORKER_CONCURRENCY: parseEnvNumber(e, 'PI_RESEARCH_WORKER_CONCURRENCY', DEFAULTS.WORKER_CONCURRENCY),
    LOCAL_KNOWLEDGE_STORE_ENABLED: parseEnvBool(e, 'PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED', DEFAULTS.LOCAL_KNOWLEDGE_STORE_ENABLED),
    GLOBAL_KNOWLEDGE_STORE_ENABLED: parseEnvBool(e, 'PI_RESEARCH_GLOBAL_KNOWLEDGE_ENABLED', DEFAULTS.GLOBAL_KNOWLEDGE_STORE_ENABLED),
    EMBEDDING_MODEL: parseEnvString(e, 'PI_RESEARCH_EMBEDDING_MODEL', DEFAULTS.EMBEDDING_MODEL)!,
    EMBEDDING_DEVICE: parseEnvString(e, 'PI_RESEARCH_EMBEDDING_DEVICE', DEFAULTS.EMBEDDING_DEVICE) as 'webgpu' | 'cpu',
    SCRAPE_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_SCRAPE_TIMEOUT_MS', DEFAULTS.SCRAPE_TIMEOUT_MS),
    KNOWLEDGE_STORE_CACHE_TTL_DAYS: parseEnvNumber(e, 'PI_RESEARCH_CACHE_TTL_DAYS', DEFAULTS.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
    EMBEDDING_MODEL_INIT_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS', DEFAULTS.EMBEDDING_MODEL_INIT_TIMEOUT_MS),
    MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: parseEnvNumber(e, 'PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING', DEFAULTS.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING),
    AVG_TOKENS_PER_SCRAPE: parseEnvNumber(e, 'PI_RESEARCH_AVG_TOKENS_PER_SCRAPE', DEFAULTS.AVG_TOKENS_PER_SCRAPE),
    MAX_CONCURRENT_SCRAPES: parseEnvNumber(e, 'PI_RESEARCH_MAX_CONCURRENT_SCRAPES', DEFAULTS.MAX_CONCURRENT_SCRAPES),
    HEALTH_CHECK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS', DEFAULTS.HEALTH_CHECK_TIMEOUT_MS),
    SEARCH_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_SEARCH_TIMEOUT_MS', DEFAULTS.SEARCH_TIMEOUT_MS),
    TUI_REFRESH_DEBOUNCE_MS: parseEnvNumber(e, 'PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS', DEFAULTS.TUI_REFRESH_DEBOUNCE_MS),
    BROWSER_TASK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS', DEFAULTS.BROWSER_TASK_TIMEOUT_MS),
    RESEARCH_MODEL: parseEnvString(e, 'PI_RESEARCH_MODEL', DEFAULTS.RESEARCH_MODEL),
    KNOWLEDGE_STORE_DIR: parseEnvString(e, 'PI_RESEARCH_KNOWLEDGE_DIR', DEFAULTS.KNOWLEDGE_STORE_DIR),
    RESEARCH_REPORT_EXPORT_ENABLED: parseEnvBool(e, 'PI_RESEARCH_REPORT_EXPORT_ENABLED', DEFAULTS.RESEARCH_REPORT_EXPORT_ENABLED),
    DEBUG: parseEnvBool(e, 'PI_RESEARCH_DEBUG', DEFAULTS.DEBUG),
  };

  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) {
      (config as any)[key] = value;
    }
  }
  return config;
}

/**
 * Robustly load current configuration.
 * Preference: process.env > local env file > global env file > defaults.
 */
export function getConfig(): Config {
  if (currentConfig) return currentConfig;

  const e = loadEnvFile();
  currentConfig = createConfig(e, process.env);
  return currentConfig;
}

/**
 * Manually override configuration (primarily for SDK/tests)
 */
export function setConfig(config: Partial<Config>): void {
  const current = getConfig();
  currentConfig = { ...current, ...config };
}

export function resetConfig(): void {
  currentConfig = null;
}

/**
 * Validate configuration object against schema
 */
export function validateConfig(config: Config): void {
  const errors = [...Value.Errors(ConfigSchema, config)];
  if (errors.length > 0) {
    throw new Error(`Invalid configuration: ${errors.map(e => `${(e as any).path || ''} ${e.message}`).join(', ')}`);
  }
}

// Helpers
function parseEnvNumber(env: Record<string, string | undefined>, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  if (isNaN(n)) {
    // FIX (#16): Warn when env value is malformed instead of silently falling back
    logger.warn(`[config] Environment variable ${key}="${v}" is not a valid number, using default: ${def}`);
    return def;
  }
  return n;
}

function parseEnvBool(env: Record<string, string | undefined>, key: string, def: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return def;
  return v.toLowerCase() === 'true';
}

function parseEnvString(env: Record<string, string | undefined>, key: string, def?: string): string | undefined {
  return env[key] || def;
}
