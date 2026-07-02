/**
 * Configuration Module
 *
 * Source of truth: .env file in the extension directory.
 * The /research-config TUI is a friendly editor for that file.
 * process.env values override the file (useful for CI / one-off overrides).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from './logger.ts';
import { getConfigDirName } from './utils/host-config.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeWorkspacePath } from './utils/text-utils.ts';

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
  /** Knowledge store isolation mode (default: 'global' — one shared store across every directory) */
  KNOWLEDGE_STORE_MODE: Type.Union([Type.Literal('none'), Type.Literal('project'), Type.Literal('global')], { default: 'global' }),
  /** Embedding model to use for the knowledge store */
  EMBEDDING_MODEL: Type.String({ default: 'onnx-community/granite-embedding-small-english-r2-ONNX' }),
  /** Hardware backend for embeddings: 'auto' (probe WebGPU viability out-of-process, fall back to CPU), 'webgpu' (force), or 'cpu' (force).
   *  Default 'auto': many real targets (VMs, containers, CI, headless/software-Vulkan hosts) have no GPU that
   *  onnxruntime-node's bundled Dawn can run compute on — and that failure is a native SIGSEGV, not a catchable
   *  JS error. 'auto' detects this via a disposable child process (a crash there can't kill us) and uses CPU. */
  EMBEDDING_DEVICE: Type.Union([Type.Literal('auto'), Type.Literal('webgpu'), Type.Literal('cpu')], { default: 'auto' }),
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
  /** Max YouTube videos transcribed per youtube_transcript call (default: 3, range 1-5) */
  YOUTUBE_TRANSCRIPT_MAX_VIDEOS: Type.Number({ minimum: 1, maximum: 5, default: 3 }),
  /** Per-video timeout for the youtube_transcript tool in ms (default: 20000, range 5-120s) */
  YOUTUBE_TRANSCRIPT_TIMEOUT_MS: Type.Number({ minimum: 5000, maximum: 120000, default: 20000 }),
  /** Preferred caption language (BCP-47 prefix) for transcripts (default: 'en') */
  YOUTUBE_TRANSCRIPT_LANG: Type.String({ default: 'en' }),
  /** Append 'youtube' to roughly one-in-N search queries for video discovery
   *  (default: 5; 1 = every query). Configured via env/config file; not surfaced
   *  in the config TUI. */
  YOUTUBE_QUERY_EVERY_N: Type.Number({ minimum: 1, maximum: 100, default: 5 }),
  /** Health check timeout in milliseconds (default: 10000ms) */
  HEALTH_CHECK_TIMEOUT_MS: Type.Number({ minimum: 2000, maximum: 120000, default: 10000 }),
  /** Default timeout for browser page operations like search (default: 45000ms) */
  SEARCH_TIMEOUT_MS: Type.Number({ minimum: 5000, maximum: 120000, default: 45000 }),
  /** TUI refresh debounce in milliseconds (default: 100ms) */
  TUI_REFRESH_DEBOUNCE_MS: Type.Number({ minimum: 0, maximum: 1000, default: 100 }),
  /** Queue-wait / overhead margin (ms) added on top of each browser operation's own nav
   *  timeout to form its scheduler task-timeout ceiling: a search task times out after
   *  SEARCH_TIMEOUT_MS + this, a scrape after SCRAPE_TIMEOUT_MS + this. Sized so a task is
   *  never killed before it has used its full nav budget plus time waiting in the queue.
   *  (default: 10000) */
  BROWSER_TASK_TIMEOUT_MS: Type.Number({ minimum: 2000, maximum: 120000, default: 10000 }),
  /** Timeout for coordinator/evaluator/repair/knowledge LLM calls in ms (default: 300000 = 5 min, range: 60s-600s).
   *  Not exposed in TUI — controlled via PI_RESEARCH_LLM_TIMEOUT_MS env var. */
  LLM_TIMEOUT_MS: Type.Number({ minimum: 60000, maximum: 600000, default: 300000 }),
  /** Chain-of-thought "thinking" level for the engine's own LLM calls (coordinator,
   *  evaluator, synthesis, JSON-repair, knowledge extraction) AND the researcher
   *  sub-agents. Default 'off': these calls emit structured JSON / cited reports, not
   *  open-ended reasoning, so thinking only burns the output-token budget (often
   *  truncating before the JSON/report block) and adds latency for at most a marginal
   *  quality gain that does not justify the cost on these structured calls.
   *  Deliberately NOT exposed in the /research-config TUI — an advanced knob set only
   *  via the PI_RESEARCH_LLM_THINKING_LEVEL env var. 'off' maps to the provider's
   *  thinking-disabled request (e.g. z.ai thinking:{type:'disabled'}). */
  LLM_THINKING_LEVEL: Type.Union([
    Type.Literal('off'),
    Type.Literal('minimal'),
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
  ], { default: 'off' }),
  /** Max output tokens for the coordinator plan + mid-round evaluator decision (and,
   *  when the evaluator synthesizes mid-round, the report). Default 16384. The blanket
   *  4096 cap previously throttled every call and could be exhausted by a thinking block
   *  before any text was emitted. Capped at the model's real ceiling at call time.
   *  Not exposed in TUI — controlled via PI_RESEARCH_PLANNING_MAX_TOKENS env var. */
  PLANNING_MAX_TOKENS: Type.Number({ minimum: 1024, maximum: 131072, default: 16384 }),
  /** Max output tokens for the final synthesized research report (the forced-synthesis
   *  evaluator call). Default 32768 so a full cited report is never truncated. Capped at
   *  the model's real maxTokens at call time.
   *  Not exposed in TUI — controlled via PI_RESEARCH_SYNTHESIS_MAX_TOKENS env var. */
  SYNTHESIS_MAX_TOKENS: Type.Number({ minimum: 1024, maximum: 131072, default: 32768 }),
  /** LLM Model override for researcher sub-agents and knowledge synthesis.
   *  Format: provider/model-id (e.g. google/gemini-2.0-flash-001) or just model-id.
   *  When set, this overrides ctx.model for researcher sub-agents (both deep and quick)
   *  and the knowledge synthesis background LLM. The coordinator and evaluator always
   *  use the caller's model (ctx.model).
   */
  RESEARCH_MODEL: Type.Optional(Type.String()),
  /** Explicit directory for the knowledge store database (overrides default) */
  KNOWLEDGE_STORE_DIR: Type.Optional(Type.String()),
  /** Directory for transient browser profile data. Defaults to a disk-backed
   *  dir (~/.cache/pi-research/profiles) rather than the system temp dir, so a
   *  RAM-backed /tmp (tmpfs) is not consumed by per-worker browser profiles.
   *  Set to a path under the system temp dir to opt back into tmpfs/RAM. */
  TMP_DIR: Type.Optional(Type.String()),
  /** Whether to automatically export a markdown research report to disk at the end (default: false) */
  RESEARCH_REPORT_EXPORT_ENABLED: Type.Boolean({ default: false }),
  /**
   * Explicit directory for exported reports. When set, reports are written here
   * verbatim (created if needed), bypassing the cwd-relative "smart" resolution.
   * Lets the skill pin a stable location instead of writing into
   * whatever repo the host agent happens to be in. Empty = smart cwd resolution.
   */
  RESEARCH_REPORT_EXPORT_DIR: Type.Optional(Type.String()),
  /** Strategy for database schema/model migrations: 'drop', 're-embed', or 'backup' (default: 'backup') */
  MIGRATION_STRATEGY: Type.Union([
    Type.Literal('drop'),
    Type.Literal('re-embed'),
    Type.Literal('backup'),
  ], { default: 'backup' }),
  /** Whether to mirror logs to the console (stdout/stderr). (default: false) */
  CONSOLE_LOG: Type.Boolean({ default: false }),
  /** Enable debug/verbose logging (writes INFO+DEBUG to log file). (default: false) */
  DEBUG: Type.Boolean({ default: false }),
  /**
   * Comma-separated list of research tools to DISABLE for every researcher in a run
   * (e.g. "scrape", or "youtube_transcript,stackexchange"). Valid tool names:
   * search, scrape, security_search, stackexchange, youtube_transcript, grep.
   * Disable-only: the list is merged into the per-run excludeTools stream, so disabled
   * tools are both removed from each researcher's toolset AND named in the
   * coordinator/evaluator "DISABLED TOOLS" prompt section. Env-only
   * (PI_RESEARCH_DISABLED_TOOLS); intentionally NOT exposed in the config TUI.
   * Empty/absent = all tools enabled.
   */
  DISABLED_TOOLS: Type.Optional(Type.String()),
});

export type Config = Static<typeof ConfigSchema>;

/** Default configuration values extracted from schema */
export const DEFAULTS: Config = Value.Create(ConfigSchema);

// ============================================================================
// Scope Definitions
// ============================================================================

/**
 * Env var keys that are project-scoped (saved per-directory in the registry).
 * All other keys are user-scoped (saved to ~/.pi/research/config.env).
 *
 * This is the SINGLE SOURCE OF TRUTH for scope assignments. The TUI scope
 * assignments, migration key lists, and saveConfig filtering all derive from
 * this set. If you change a key's scope in the TUI, update this set too.
 */
const LOCAL_SCOPE_KEYS = new Set([
  'PI_RESEARCH_DEFAULT_RESEARCH_DEPTH',
  'PI_RESEARCH_KNOWLEDGE_STORE_MODE',
]);

/**
 * True for a per-directory (project-scoped) env-var key. Exported so the CLI's config.env→env
 * bridge can EXCLUDE these: promoting a per-directory key into process.env would make config.env
 * out-rank the per-directory registry (process.env is top precedence), silently defeating a
 * per-directory override. Kept as a file layer instead, the registry can override it per-cwd —
 * matching how the pi extension / SDK resolve config.
 */
export function isProjectScopedKey(key: string): boolean {
  return LOCAL_SCOPE_KEYS.has(key);
}

/**
 * User-scoped keys for one-time migration from registry → config.env.
 * Derived from ALL schema keys minus LOCAL_SCOPE_KEYS, plus a few extra keys
 * not in the schema but present in the env.
 */
const USER_MIGRATION_KEYS = [
  // Core user-scoped from schema
  'PI_RESEARCH_TIMEOUT_MS',
  'PI_RESEARCH_MAX_RESEARCHERS',
  'PI_RESEARCH_MAX_RETRIES',
  'PI_RESEARCH_RETRY_DELAY_MS',
  'PI_RESEARCH_MAX_SCRAPE_BATCHES',
  'PI_RESEARCH_WORKER_THREADS',
  'PI_RESEARCH_WORKER_CONCURRENCY',
  'PI_RESEARCH_EMBEDDING_MODEL',
  'PI_RESEARCH_EMBEDDING_DEVICE',
  'PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS',
  'PI_RESEARCH_SCRAPE_TIMEOUT_MS',
  'PI_RESEARCH_CACHE_TTL_DAYS',
  'PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING',
  'PI_RESEARCH_AVG_TOKENS_PER_SCRAPE',
  'PI_RESEARCH_MAX_CONCURRENT_SCRAPES',
  'PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS',
  'PI_RESEARCH_SEARCH_TIMEOUT_MS',
  'PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS',
  'PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS',
  'PI_RESEARCH_LLM_TIMEOUT_MS',
  'PI_RESEARCH_LLM_THINKING_LEVEL',
  'PI_RESEARCH_PLANNING_MAX_TOKENS',
  'PI_RESEARCH_SYNTHESIS_MAX_TOKENS',
  'PI_RESEARCH_MIGRATION_STRATEGY',
  'PI_RESEARCH_CONSOLE_LOG',
  'PI_RESEARCH_MODEL',
  'PI_RESEARCH_KNOWLEDGE_DIR',
  'PI_RESEARCH_TMP_DIR',
  'PI_RESEARCH_REPORT_EXPORT_ENABLED',
  'PI_RESEARCH_REPORT_EXPORT_DIR',
  'PI_RESEARCH_DEBUG',
];

// ============================================================================
// Centralized Project Settings Storage
// ============================================================================

/**
 * Returns the path to the centralized project settings file.
 */
export function getProjectSettingsRegistryPath(): string {
  // State lives under pi-research's OWN namespace (~/.pi/research/state), beside
  // config.env and knowledge_db — not in the host pi config dir root (~/.pi/state),
  // which would pollute and risk colliding with the host's own state.
  const stateDir = process.env['PI_RESEARCH_STATE_DIR']
    ?? path.join(getGlobalConfigDir(), 'state');
  return path.join(stateDir, 'project-settings.json');
}

/**
 * Load all project settings from the centralized registry.
 */
function loadProjectSettingsRegistry(): Record<string, Record<string, string>> {
  const registryPath = getProjectSettingsRegistryPath();
  try {
    if (fs.existsSync(registryPath)) {
      const content = fs.readFileSync(registryPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    logger.warn('[config] Failed to read project settings registry:', err);
  }
  return {};
}

/**
 * Internal helper for synchronous sleep.
 * Uses Atomics.wait (Node.js main thread) with a non-busy-wait fallback
 * that blocks on a file descriptor (pipe) so the thread actually yields.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_err) {
    // SharedArrayBuffer is unavailable (extremely unlikely in Node.js, but possible
    // in strict security contexts). Fall back to a spin-wait as a last resort.
    // This code path is essentially dead in normal Node.js environments.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Save the centralized project settings registry.
 */
function saveProjectSettingsRegistry(registry: Record<string, Record<string, string>>): void {
  const registryPath = getProjectSettingsRegistryPath();
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const lockPath = `${registryPath}.lock`;
  let lockFd: number | null = null;
  const maxRetries = 100;
  
  try {
    for (let i = 0; i < maxRetries; i++) {
      try {
        lockFd = fs.openSync(lockPath, 'wx');
        break;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Stale lock check
          try {
            const stats = fs.statSync(lockPath);
            if (Date.now() - stats.mtimeMs > 30000) {
              fs.unlinkSync(lockPath);
              continue;
            }
          } catch { /* ignore */ }
          
          sleepSync(50);
          continue;
        }
        throw err;
      }
    }
    
    if (lockFd !== null) {
      // Atomic write: a bare writeFileSync could be truncated by a crash/ENOSPC mid-write,
      // leaving invalid JSON that loadProjectSettingsRegistry silently resets to {} — wiping
      // every workspace's saved settings. Write a temp then rename (atomic on the same FS).
      const tmpPath = `${registryPath}.tmp.${process.pid}.${Date.now()}`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
        fs.renameSync(tmpPath, registryPath);
      } catch (writeErr) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw writeErr;
      }
    } else {
      throw new Error(`Failed to acquire lock for project settings registry after ${maxRetries} retries. Aborting to prevent data corruption.`);
    }
  } catch (err) {
    // Rethrow so the caller (saveConfig → /research-config) surfaces the failure instead of
    // reporting a save that silently did not persist. Mirrors the user-scope config.env writer.
    logger.error('[config] Failed to save project settings registry:', err);
    throw err;
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

// ============================================================================
// Env-file persistence
// ============================================================================

/**
 * Returns the global configuration directory (~/.pi/research).
 */
export function getGlobalConfigDir(): string {
  return path.join(os.homedir(), getConfigDirName(), 'research');
}

/**
 * Returns the global environment file path (~/.pi/research/config.env).
 */
export function getGlobalEnvFilePath(): string {
  return path.join(getGlobalConfigDir(), 'config.env');
}

/**
 * The interface (consumer) through which pi-research is being used.
 *
 * Each interface can have an optional per-interface config overlay file at
 * ~/.pi/research/{interface}.env that layers over the base config.env.
 * Keys in the overlay win over the base file but lose to process.env and
 * the centralized project registry.
 *
 * - 'pi'        → src/index.ts (the pi extension: /research, /research-config, /knowledge-store)
 * - 'cli'       → src/cli.ts (the standalone `pi-research` CLI / agent skill —
 *                 the surface every skills-aware host, including OpenClaw, runs)
 *
 * Each front-end reads ONLY its own overlay, so the standalone CLI / agent skill
 * (cli.env) can be configured independently of the pi extension (pi.env).
 *
 * NOTE: the programmatic SDK (src/sdk.ts) is deliberately NOT an interface here —
 * it is a library configured from code via ResearchSDKOptions, not from a global
 * overlay file. See `ignoreGlobalConfig` in the SDK options for hermetic usage.
 */
export type ConfigInterface = 'pi' | 'cli';

/**
 * Returns the per-interface overlay file path (~/.pi/research/{iface}.env).
 * The file is optional — only read if it exists.
 */
export function getInterfaceEnvFilePath(iface: ConfigInterface): string {
  return path.join(getGlobalConfigDir(), `${iface}.env`);
}

/**
 * Returns the local environment file path for a given directory.
 * @deprecated Legacy .pi-research.env files are auto-migrated to the centralized registry.
 * @internal
 */
function getLocalEnvFilePath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, '.pi-research.env');
}

/**
 * Returns the active database directory.
 */
export function getDbDir(config?: Config, cwd: string = process.cwd()): string {
  const cfg = config || getConfig(cwd);
  if (cfg.KNOWLEDGE_STORE_DIR) {
    return path.isAbsolute(cfg.KNOWLEDGE_STORE_DIR) 
      ? cfg.KNOWLEDGE_STORE_DIR 
      : path.resolve(cwd, cfg.KNOWLEDGE_STORE_DIR);
  }
  // Default unified database in the global config directory
  return path.join(getGlobalConfigDir(), 'knowledge_db');
}

export interface KnowledgeStoreModeInfo {
  mode: 'none' | 'project' | 'global';
  /** Human-readable source of the EFFECTIVE value (highest-precedence source that set it). */
  origin: string;
  /** Physical LanceDB directory backing the store (shared across project/global modes). */
  dbDir: string;
}

/**
 * Resolve the effective KNOWLEDGE_STORE_MODE for a directory AND explain WHERE the value came
 * from. Backs the `knowledge-config` CLI and any agent/user asking "why is the store X here".
 * The origin walks the same precedence createConfig applies, highest first:
 *   env var  >  per-directory project registry  >  {iface}.env overlay  >  config.env  >  default.
 * (Legacy .pi-research.env local keys are auto-migrated into the registry on load, so a value
 * there surfaces as the registry origin.)
 */
export function describeKnowledgeStoreMode(
  cwd: string = process.cwd(),
  iface?: ConfigInterface,
): KnowledgeStoreModeInfo {
  const cfg = getConfig(cwd, iface);
  const KEY = 'PI_RESEARCH_KNOWLEDGE_STORE_MODE';
  const fileHasKey = (p: string): boolean => {
    try {
      return fs.existsSync(p) && parseDotEnv(fs.readFileSync(p, 'utf-8'))[KEY] !== undefined;
    } catch {
      return false;
    }
  };

  let origin = 'built-in default';
  if (process.env[KEY] !== undefined) {
    origin = 'environment variable';
  } else {
    let registryHasKey = false;
    try {
      const registry = loadProjectSettingsRegistry();
      registryHasKey = registry[normalizeWorkspacePath(cwd)]?.[KEY] !== undefined;
    } catch { /* unreadable registry → not the origin */ }
    if (registryHasKey) origin = 'this directory (project settings)';
    else if (iface && fileHasKey(getInterfaceEnvFilePath(iface))) origin = `${iface}.env overlay`;
    else if (fileHasKey(getGlobalEnvFilePath())) origin = 'config.env (machine-wide default)';
  }

  return { mode: cfg.KNOWLEDGE_STORE_MODE, origin, dbDir: getDbDir(cfg, cwd) };
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
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Load environment variables from global and local files.
 * Order: Global File < Interface overlay < Legacy .env < Centralized Registry (WINS)
 */
function loadEnvFiles(cwd: string, iface?: ConfigInterface): Record<string, string> {
  const merged: Record<string, string> = {};
  const globalPath = getGlobalEnvFilePath();
  const registry = loadProjectSettingsRegistry();
  const normalizedCwd = normalizeWorkspacePath(cwd);
  const homeRegistry = registry[normalizeWorkspacePath(os.homedir())];

  // 1. ONE-TIME MIGRATION: Populate config.env from HOME registry if missing
  try {
    if (!fs.existsSync(globalPath) && homeRegistry && Object.keys(homeRegistry).length > 0) {
      logger.info('[config] config.env missing. Initializing from user settings in central registry...');
      const migrated: Record<string, string> = {};
      for (const key of USER_MIGRATION_KEYS) {
        if (homeRegistry[key] !== undefined) migrated[key] = homeRegistry[key];
      }
      if (Object.keys(migrated).length > 0) {
        // We use a dummy config to trigger saveConfig('user')
        const dummyConfig = createConfig(migrated, {});
        saveConfig(dummyConfig, 'user', cwd);
      }
    }
  } catch (err) {
    logger.warn('[config] Failed one-time config.env migration:', err);
  }

  // 2. Load Global user config
  try {
    if (fs.existsSync(globalPath)) {
      Object.assign(merged, parseDotEnv(fs.readFileSync(globalPath, 'utf-8')));
    }
  } catch (err) {
    logger.warn('[config] Failed to read global env file:', err);
  }

  // 2b. Per-interface overlay (~/.pi/research/{iface}.env) — optional, wins over base.
  if (iface) {
    const ifacePath = getInterfaceEnvFilePath(iface);
    try {
      if (fs.existsSync(ifacePath)) {
        Object.assign(merged, parseDotEnv(fs.readFileSync(ifacePath, 'utf-8')));
      }
    } catch (err) {
      logger.warn(`[config] Failed to read interface config ${ifacePath}:`, err);
    }
  }

  // 3. Load Legacy .pi-research.env in CWD
  const legacyPath = getLocalEnvFilePath(cwd);
  let legacyEnv: Record<string, string> = {};
  if (fs.existsSync(legacyPath)) {
    try {
      logger.warn(`[config] WARNING: .pi-research.env files are deprecated. Settings will be auto-migrated to the centralized registry. Remove ${legacyPath} after migration.`);
      legacyEnv = parseDotEnv(fs.readFileSync(legacyPath, 'utf-8'));
      Object.assign(merged, legacyEnv);
      
      // Auto-migrate legacy settings to the central registry — but only LOCAL_SCOPE_KEYS. The
      // registry is project-scoped storage by design (saveConfig writes only these keys to it);
      // persisting user-scoped legacy keys would freeze them per-workspace and silently override
      // the user's global config.env forever. Non-local legacy keys still apply to THIS resolution
      // via the Object.assign(merged, legacyEnv) above — they just aren't persisted.
      const legacyLocal = Object.fromEntries(
        Object.entries(legacyEnv).filter(([k]) => LOCAL_SCOPE_KEYS.has(k))
      );
      const existingLocal = Object.fromEntries(
        Object.entries(registry[normalizedCwd] ?? {}).filter(([k]) => LOCAL_SCOPE_KEYS.has(k))
      );
      if (Object.keys(legacyLocal).length > 0 && JSON.stringify(existingLocal) !== JSON.stringify(legacyLocal)) {
        logger.info(`[config] Migrating legacy .pi-research.env settings from ${cwd} to central registry...`);
        registry[normalizedCwd] = { ...registry[normalizedCwd], ...legacyLocal };
        saveProjectSettingsRegistry(registry);
      }
    } catch (err) {
      logger.warn(`[config] Failed to load legacy settings for ${cwd}:`, err);
    }
  }

  // 4. Apply centralized project settings. The registry is project-scoped storage: ONLY
  //    LOCAL_SCOPE_KEYS are applied (and may override), never user-scoped keys — those belong to
  //    config.env. Any non-local key present here is stale pollution (e.g. a pre-fix legacy
  //    migration) and is ignored rather than allowed to override the user's global settings.
  if (registry[normalizedCwd]) {
    for (const [key, val] of Object.entries(registry[normalizedCwd])) {
      if (LOCAL_SCOPE_KEYS.has(key)) {
        // Don't interpolate values in warnings — a config key could carry a secret and
        // redactSecrets won't catch short/non-standard tokens. Key + winner is enough.
        if (legacyEnv[key] !== undefined && legacyEnv[key] !== val) {
          logger.warn(`[config] Config divergence for ${key} in ${cwd}: registry value differs from legacy .pi-research.env. Registry wins.`);
        }
        merged[key] = val;
      } else if (merged[key] !== undefined && merged[key] !== val) {
        logger.warn(`[config] Ignoring stale user-scoped ${key} in the project registry (config.env wins). Re-save your user settings to drop it.`);
      }
    }
  } else if (Object.keys(merged).length === 0 && !fs.existsSync(legacyPath) && !fs.existsSync(globalPath)) {
    // 5. Warning for missing config
    logger.warn(`[config] No configuration found for workspace: ${cwd}. Using code defaults. Run /research-config to configure.`);
  }

  return merged;
}

/**
 * Write config back to env file.
 */
export function saveConfig(config: Config, scope: 'local' | 'user' = 'local', cwd: string = process.cwd()): void {
  // ALL keys — canonical env var name → value
  // Note: PI_RESEARCH_CACHE_TTL_DAYS is the canonical name (matches .env.example).
  // PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS is accepted at read-time for backward compat.
  const allValues: Record<string, string> = {
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
    PI_RESEARCH_KNOWLEDGE_STORE_MODE: config.KNOWLEDGE_STORE_MODE,
    PI_RESEARCH_EMBEDDING_MODEL: config.EMBEDDING_MODEL,
    PI_RESEARCH_EMBEDDING_DEVICE: config.EMBEDDING_DEVICE,
    PI_RESEARCH_SCRAPE_TIMEOUT_MS: String(config.SCRAPE_TIMEOUT_MS),
    PI_RESEARCH_CACHE_TTL_DAYS: String(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
    PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS: String(config.EMBEDDING_MODEL_INIT_TIMEOUT_MS),
    PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: String(config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING),
    PI_RESEARCH_AVG_TOKENS_PER_SCRAPE: String(config.AVG_TOKENS_PER_SCRAPE),
    PI_RESEARCH_MAX_CONCURRENT_SCRAPES: String(config.MAX_CONCURRENT_SCRAPES),
    PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS: String(config.YOUTUBE_TRANSCRIPT_MAX_VIDEOS),
    PI_RESEARCH_YOUTUBE_TRANSCRIPT_TIMEOUT_MS: String(config.YOUTUBE_TRANSCRIPT_TIMEOUT_MS),
    PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG: config.YOUTUBE_TRANSCRIPT_LANG,
    PI_RESEARCH_YOUTUBE_QUERY_EVERY_N: String(config.YOUTUBE_QUERY_EVERY_N),
    PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS: String(config.BROWSER_TASK_TIMEOUT_MS),
    PI_RESEARCH_LLM_TIMEOUT_MS: String(config.LLM_TIMEOUT_MS),
    PI_RESEARCH_LLM_THINKING_LEVEL: config.LLM_THINKING_LEVEL,
    PI_RESEARCH_PLANNING_MAX_TOKENS: String(config.PLANNING_MAX_TOKENS),
    PI_RESEARCH_SYNTHESIS_MAX_TOKENS: String(config.SYNTHESIS_MAX_TOKENS),
    PI_RESEARCH_MIGRATION_STRATEGY: config.MIGRATION_STRATEGY,
    PI_RESEARCH_CONSOLE_LOG: String(config.CONSOLE_LOG),
    ...(config.RESEARCH_MODEL ? { PI_RESEARCH_MODEL: config.RESEARCH_MODEL } : {}),
    ...(config.KNOWLEDGE_STORE_DIR ? { PI_RESEARCH_KNOWLEDGE_DIR: config.KNOWLEDGE_STORE_DIR } : {}),
    ...(config.TMP_DIR ? { PI_RESEARCH_TMP_DIR: config.TMP_DIR } : {}),
    PI_RESEARCH_REPORT_EXPORT_ENABLED: String(config.RESEARCH_REPORT_EXPORT_ENABLED),
    ...(config.RESEARCH_REPORT_EXPORT_DIR ? { PI_RESEARCH_REPORT_EXPORT_DIR: config.RESEARCH_REPORT_EXPORT_DIR } : {}),
    PI_RESEARCH_DEBUG: String(config.DEBUG),
    ...(config.DISABLED_TOOLS ? { PI_RESEARCH_DISABLED_TOOLS: config.DISABLED_TOOLS } : {}),
  };

  // Scope-filter: only write the keys that belong to the target scope.
  // This prevents cross-contamination (project-scoped keys leaking into config.env
  // and user-scoped keys leaking into the project registry).
  const newValues = scope === 'local'
    ? Object.fromEntries(Object.entries(allValues).filter(([k]) => LOCAL_SCOPE_KEYS.has(k)))
    : Object.fromEntries(Object.entries(allValues).filter(([k]) => !LOCAL_SCOPE_KEYS.has(k)));

  if (scope === 'local') {
    // CENTRALIZED PROJECT STORAGE
    const registry = loadProjectSettingsRegistry();
    const normalizedCwd = normalizeWorkspacePath(cwd);
    registry[normalizedCwd] = newValues;
    saveProjectSettingsRegistry(registry);
    
    logger.debug(`[config] Saved project settings for ${normalizedCwd} to central registry.`);
    return;
  }

  // USER STORAGE
  const p = getGlobalEnvFilePath();
  const lockPath = `${p}.lock`;
  const dir = path.dirname(p);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Simple synchronous file lock
  let lockFd: number | null = null;
  const lockRetryDelay = 50;
  const lockMaxRetries = 100; // 5 seconds total

  for (let i = 0; i < lockMaxRetries; i++) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Check if lock is stale (older than 30s)
        try {
          const stats = fs.statSync(lockPath);
          if (Date.now() - stats.mtimeMs > 30000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore */ }

        const jitter = Math.floor(Math.random() * 20);
        sleepSync(lockRetryDelay + jitter);
        continue;
      }
      throw err;
    }
  }

  if (lockFd === null) {
    throw new Error(`Failed to acquire lock for ${p} after ${lockMaxRetries} retries`);
  }
  
  try {
    let lines: string[] = [];
    if (fs.existsSync(p)) {
      lines = fs.readFileSync(p, 'utf-8').split('\n');
    } else {
      lines = [
        `# pi-research global configuration`,
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
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (!updatedKeys.has(key) && val !== '') {
        if (outLines.length > 0 && outLines[outLines.length - 1]?.trim() !== '') {
          outLines.push('');
        }
        outLines.push(`${key}=${val}`);
        updatedKeys.add(key);
      }
    }

    // Atomic write
    const tmpPath = `${p}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, outLines.join('\n'), 'utf-8');
    try {
      fs.renameSync(tmpPath, p);
    } catch (renameErr) {
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
  } finally {
    // lockFd is guaranteed non-null here (thrown before try if null)
    fs.closeSync(lockFd!);
    try {
      fs.unlinkSync(lockPath);
    } catch { /* ignore */ }
  }
}

// ============================================================================
// Internal State
// ============================================================================

/**
 * Config cache keyed by normalized CWD.
 * Avoids stale cached config when the process CWD changes between sessions.
 */
const configCache = new Map<string, Config>();

/**
 * Internal factory for creating a configuration object from env.
 */
export function createConfig(env: Record<string, string | undefined>, processEnv: Record<string, string | undefined>): Config {
  const e = { ...env, ...processEnv };

  const raw = {
    RESEARCHER_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_TIMEOUT_MS', DEFAULTS.RESEARCHER_TIMEOUT_MS, 180000, 1800000),
    MAX_CONCURRENT_RESEARCHERS: parseEnvNumber(e, 'PI_RESEARCH_MAX_RESEARCHERS', DEFAULTS.MAX_CONCURRENT_RESEARCHERS, 1, 5),
    RESEARCHER_MAX_RETRIES: parseEnvNumber(e, 'PI_RESEARCH_MAX_RETRIES', DEFAULTS.RESEARCHER_MAX_RETRIES, 0, 5),
    RESEARCHER_MAX_RETRY_DELAY_MS: parseEnvNumber(e, 'PI_RESEARCH_RETRY_DELAY_MS', DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS, 100, 10000),
    DEFAULT_RESEARCH_DEPTH: parseEnvNumber(e, 'PI_RESEARCH_DEFAULT_RESEARCH_DEPTH', DEFAULTS.DEFAULT_RESEARCH_DEPTH, 1, 3),
    MAX_SCRAPE_BATCHES: parseEnvNumber(e, 'PI_RESEARCH_MAX_SCRAPE_BATCHES', DEFAULTS.MAX_SCRAPE_BATCHES, 0, 99),
    WORKER_THREADS: parseEnvNumber(e, 'PI_RESEARCH_WORKER_THREADS', DEFAULTS.WORKER_THREADS, 1, 10),
    WORKER_CONCURRENCY: parseEnvNumber(e, 'PI_RESEARCH_WORKER_CONCURRENCY', DEFAULTS.WORKER_CONCURRENCY, 1, 10),
    KNOWLEDGE_STORE_MODE: parseEnvEnum(e, 'PI_RESEARCH_KNOWLEDGE_STORE_MODE', ['none', 'project', 'global'] as const, 'global'),
    EMBEDDING_MODEL: parseEnvString(e, 'PI_RESEARCH_EMBEDDING_MODEL', DEFAULTS.EMBEDDING_MODEL)!,
    EMBEDDING_DEVICE: parseEnvEnum(e, 'PI_RESEARCH_EMBEDDING_DEVICE', ['auto', 'webgpu', 'cpu'] as const, DEFAULTS.EMBEDDING_DEVICE),
    SCRAPE_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_SCRAPE_TIMEOUT_MS', DEFAULTS.SCRAPE_TIMEOUT_MS, 5000, 120000),
    // Accept both canonical name and legacy name for backward compatibility.
    // saveConfig writes the canonical name (PI_RESEARCH_CACHE_TTL_DAYS) but
    // older sessions may have written PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS.
    KNOWLEDGE_STORE_CACHE_TTL_DAYS:
      e['PI_RESEARCH_CACHE_TTL_DAYS'] !== undefined
        ? parseEnvNumber(e, 'PI_RESEARCH_CACHE_TTL_DAYS', DEFAULTS.KNOWLEDGE_STORE_CACHE_TTL_DAYS, 1, 365)
        : parseEnvNumber(e, 'PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS', DEFAULTS.KNOWLEDGE_STORE_CACHE_TTL_DAYS, 1, 365),
    EMBEDDING_MODEL_INIT_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS', DEFAULTS.EMBEDDING_MODEL_INIT_TIMEOUT_MS, 10000, 600000),
    MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: parseEnvNumber(e, 'PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING', DEFAULTS.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING, 0.05, 1.0),
    AVG_TOKENS_PER_SCRAPE: parseEnvNumber(e, 'PI_RESEARCH_AVG_TOKENS_PER_SCRAPE', DEFAULTS.AVG_TOKENS_PER_SCRAPE, 500, 10000),
    MAX_CONCURRENT_SCRAPES: parseEnvNumber(e, 'PI_RESEARCH_MAX_CONCURRENT_SCRAPES', DEFAULTS.MAX_CONCURRENT_SCRAPES, 1, 20),
    YOUTUBE_TRANSCRIPT_MAX_VIDEOS: parseEnvNumber(e, 'PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS', DEFAULTS.YOUTUBE_TRANSCRIPT_MAX_VIDEOS, 1, 5),
    YOUTUBE_TRANSCRIPT_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_YOUTUBE_TRANSCRIPT_TIMEOUT_MS', DEFAULTS.YOUTUBE_TRANSCRIPT_TIMEOUT_MS, 5000, 120000),
    YOUTUBE_TRANSCRIPT_LANG: parseEnvString(e, 'PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG', DEFAULTS.YOUTUBE_TRANSCRIPT_LANG)!,
    YOUTUBE_QUERY_EVERY_N: parseEnvNumber(e, 'PI_RESEARCH_YOUTUBE_QUERY_EVERY_N', DEFAULTS.YOUTUBE_QUERY_EVERY_N, 1, 100),
    HEALTH_CHECK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS', DEFAULTS.HEALTH_CHECK_TIMEOUT_MS, 2000, 120000),
    SEARCH_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_SEARCH_TIMEOUT_MS', DEFAULTS.SEARCH_TIMEOUT_MS, 5000, 120000),
    TUI_REFRESH_DEBOUNCE_MS: parseEnvNumber(e, 'PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS', DEFAULTS.TUI_REFRESH_DEBOUNCE_MS, 0, 1000),
    BROWSER_TASK_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS', DEFAULTS.BROWSER_TASK_TIMEOUT_MS, 2000, 120000),
    LLM_TIMEOUT_MS: parseEnvNumber(e, 'PI_RESEARCH_LLM_TIMEOUT_MS', DEFAULTS.LLM_TIMEOUT_MS, 60000, 600000),
    LLM_THINKING_LEVEL: parseEnvEnum(e, 'PI_RESEARCH_LLM_THINKING_LEVEL', ['off', 'minimal', 'low', 'medium', 'high'] as const, DEFAULTS.LLM_THINKING_LEVEL),
    PLANNING_MAX_TOKENS: parseEnvNumber(e, 'PI_RESEARCH_PLANNING_MAX_TOKENS', DEFAULTS.PLANNING_MAX_TOKENS, 1024, 131072),
    SYNTHESIS_MAX_TOKENS: parseEnvNumber(e, 'PI_RESEARCH_SYNTHESIS_MAX_TOKENS', DEFAULTS.SYNTHESIS_MAX_TOKENS, 1024, 131072),
    MIGRATION_STRATEGY: parseEnvEnum(e, 'PI_RESEARCH_MIGRATION_STRATEGY', ['drop', 're-embed', 'backup'] as const, DEFAULTS.MIGRATION_STRATEGY),
    CONSOLE_LOG: parseEnvBool(e, 'PI_RESEARCH_CONSOLE_LOG', DEFAULTS.CONSOLE_LOG),
    RESEARCH_MODEL: parseEnvString(e, 'PI_RESEARCH_MODEL', DEFAULTS.RESEARCH_MODEL),
    KNOWLEDGE_STORE_DIR: parseEnvString(e, 'PI_RESEARCH_KNOWLEDGE_DIR', DEFAULTS.KNOWLEDGE_STORE_DIR),
    TMP_DIR: parseEnvString(e, 'PI_RESEARCH_TMP_DIR', DEFAULTS.TMP_DIR),
    RESEARCH_REPORT_EXPORT_ENABLED: parseEnvBool(e, 'PI_RESEARCH_REPORT_EXPORT_ENABLED', DEFAULTS.RESEARCH_REPORT_EXPORT_ENABLED),
    RESEARCH_REPORT_EXPORT_DIR: parseEnvString(e, 'PI_RESEARCH_REPORT_EXPORT_DIR', DEFAULTS.RESEARCH_REPORT_EXPORT_DIR),
    DEBUG: parseEnvBool(e, 'PI_RESEARCH_DEBUG', DEFAULTS.DEBUG),
    DISABLED_TOOLS: parseEnvString(e, 'PI_RESEARCH_DISABLED_TOOLS', DEFAULTS.DISABLED_TOOLS),
  };

  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) {
      (config as any)[key] = value;
    }
  }

  // Bridge a config/TUI-set DEBUG into the PI_RESEARCH_DEBUG env var so isVerboseFromEnv()
  // (which reads the env var — it cannot import config without a circular dependency) picks it
  // up. Only ever opt INTO verbose ('true'), never write 'false': createConfig runs with the
  // shared process.env, and getConfig merges process.env LAST, so pinning 'false' here from the
  // first-resolved interface would override a later interface whose own config sets DEBUG=true
  // (silently disabling its debug logging). Enabling-only is a safe, monotonic bridge.
  if (config.DEBUG && processEnv['PI_RESEARCH_DEBUG'] === undefined) {
    processEnv['PI_RESEARCH_DEBUG'] = 'true';
  }

  return config;
}

/**
 * Robustly load configuration for a specific directory and optional interface.
 *
 * Resolution order (later wins):
 *   Defaults < config.env < {iface}.env (optional) < legacy .pi-research.env < project registry < process.env
 *
 * The optional `iface` parameter selects a per-interface overlay file
 * (~/.pi/research/{iface}.env) that layers over the base config.env.
 * This lets the pi and cli front-ends carry independent
 * model/config settings while all falling back to the shared base when
 * not set. (The SDK is code-configured and has no overlay file.)
 *
 * Results are cached by (cwd, iface) pair.
 */
export function getConfig(cwd: string = process.cwd(), iface?: ConfigInterface): Config {
  const cacheKey = `${normalizeWorkspacePath(cwd)}:${iface ?? ''}`;
  const cached = configCache.get(cacheKey);
  if (cached) return cached;

  const e = loadEnvFiles(cwd, iface);
  const config = createConfig(e, process.env);

  configCache.set(cacheKey, config);
  return config;
}

/**
 * Manually override configuration.
 * Uses the cache for the current CWD (for CLI/test compatibility).
 */
export function setConfig(config: Partial<Config>, iface?: ConfigInterface): void {
  const current = getConfig(process.cwd(), iface);
  const cacheKey = `${normalizeWorkspacePath(process.cwd())}:${iface ?? ''}`;
  configCache.set(cacheKey, { ...current, ...config });
}

export function resetConfig(): void {
  configCache.clear();
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
function parseEnvNumber(env: Record<string, string | undefined>, key: string, def: number, min?: number, max?: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  if (isNaN(n)) {
    logger.warn(`[config] Environment variable ${key}="${v}" is not a valid number, using default: ${def}`);
    return def;
  }
  if (min !== undefined && n < min) {
    logger.warn(`[config] ${key}=${n} is below minimum ${min}, clamping`);
    return min;
  }
  if (max !== undefined && n > max) {
    logger.warn(`[config] ${key}=${n} is above maximum ${max}, clamping`);
    return max;
  }
  return n;
}

function parseEnvBool(env: Record<string, string | undefined>, key: string, def: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return def;
  // Strict by design: only the literal 'true' (any case) is truthy; every other value is false.
  // This is intentional and asserted in config.test.ts ('1'/'yes' → false) — do not loosen it.
  return v.toLowerCase() === 'true';
}

function parseEnvString(env: Record<string, string | undefined>, key: string, def?: string): string | undefined {
  return env[key] || def;
}

/**
 * Parse an env var constrained to a fixed set of allowed values. An invalid value
 * falls back to the default with a WARN rather than being cast straight through —
 * otherwise a typo like PI_RESEARCH_KNOWLEDGE_STORE_MODE=projetc silently produces
 * a value no downstream switch handles, degrading behavior with no signal.
 */
function parseEnvEnum<T extends string>(
  env: Record<string, string | undefined>,
  key: string,
  allowed: readonly T[],
  def: T,
): T {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  logger.warn(`[config] Invalid ${key}="${raw}" (expected one of: ${allowed.join(', ')}). Using default "${def}".`);
  return def;
}
