/**
 * pi-research — standalone CLI
 *
 * A thin, dependency-free command line over the pi-research programmatic SDK
 * (src/sdk.ts). It lets any tool — Claude Code, Cursor, a shell script, CI — run
 * multi-agent web research without the pi CLI or TUI.
 *
 *   pi-research research "<query>" [--depth N] [--model provider/id]
 *   pi-research knowledge "<q>" ["<q2>" ...]
 *   pi-research status [--json]
 *   pi-research help
 *
 * Design goals: simple, robust, zero unconfigured-runtime surprises. It fails
 * FAST with an actionable message (and the exact config locations) when the
 * package or a model/API key is missing, instead of spinning up the browser pool
 * and embedding model only to die on the first LLM call.
 *
 * Built to a single plain-JS bundle (dist/cli.mjs) via esbuild --packages=external,
 * so it runs under plain `node` with no TypeScript loader. Exposed as the
 * `pi-research` bin in package.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// pi-research internals (bundled; native/npm deps stay external).
import {
  initResearchSDK,
  runDeepResearch,
  searchKnowledge,
  shutdownResearchSDK,
  type KnowledgeSearchResult,
} from './sdk.ts';
import type { HeadlessObserverOptions } from './orchestration/headless-observer.ts';
import { exportResearchReport, appendExportMessage } from './utils/research-export.ts';
import { getConfig, getGlobalConfigDir, getGlobalEnvFilePath, getInterfaceEnvFilePath } from './config.ts';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Read the package version from package.json at runtime so `--version`/`status`
 * never drift from package.json. `../package.json` relative to import.meta.url
 * resolves correctly both in dev (src/cli.ts → repo root) and when bundled
 * (dist/cli.mjs → installed package root).
 */
function readPkgVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const PKG_VERSION = readPkgVersion();
const BINARY_NAME = 'pi-research';

/** sysexits-style exit codes (kept distinct so callers/agents can branch). */
export const EXIT = {
  OK: 0,
  /** Misuse / bad arguments. */
  USAGE: 64,
  /** Missing setup: package, model, or API key not configured. */
  CONFIG: 78,
  /** Something went wrong at runtime (network, provider, internal). */
  SOFTWARE: 70,
} as const;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function toStderr(s: string): void {
  process.stderr.write(s);
}

function toStdout(s: string): void {
  process.stdout.write(s);
}

/** A compact human-readable summary of a value for --json status output. */
function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/**
 * Build a headless observer that writes a single concise progress line per
 * lifecycle event to stderr. Keeps a long research run visible without spamming
 * stdout (the report goes to stdout, untouched).
 */
function makeProgressObserver(): HeadlessObserverOptions {
  return {
    enableLogging: false,
    onProgress: (event: string, data?: any) => {
      switch (event) {
        case 'planning_success':
          toStderr(`  • plan: ${data?.plan?.researchers?.length ?? '?'} researcher(s)\n`);
          break;
        case 'round_start':
          toStderr(`  • round ${data?.round}\n`);
          break;
        case 'search_start':
          toStderr(`  • search burst: ${data?.queries?.length ?? 0} query/${(data?.queries?.length ?? 0) === 1 ? '' : 's'}\n`);
          break;
        case 'researcher_start':
          toStderr(`  • researcher ${data?.id}: ${data?.name}\n`);
          break;
        case 'researcher_failure':
          toStderr(`  • researcher ${data?.id} failed: ${data?.error}\n`);
          break;
        case 'evaluation_decision':
          toStderr(`  • evaluator: ${data?.action}\n`);
          break;
        case 'tokens_consumed':
          if (data?.cost) toStderr(`  • tokens: ${data?.tokens ?? 0} ($${Number(data.cost).toFixed(4)})\n`);
          break;
        case 'complete':
          toStderr(`  • complete (${data?.result?.length ?? 0} chars)\n`);
          break;
        case 'error':
          toStderr(`  • error: ${data?.message}\n`);
          break;
        default:
          // Other granular events are intentionally silent to keep output clean.
          break;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration bootstrap
// ---------------------------------------------------------------------------

/**
 * Parse a minimal KEY=VALUE dotenv file. Mirrors the parser in config.ts but is
 * self-contained here so the CLI can bridge auth vars into process.env without a
 * dependency on an unexported helper.
 */
function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).replace(/\r$/, '');
    // Strip surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Bridge the CLI's config files into process.env for keys not already set in the
 * real environment. Layers the base `~/.pi/research/config.env` then the CLI's
 * own `~/.pi/research/cli.env` overlay (overlay wins), or a `--config <path>`
 * override in place of the base.
 *
 * Why: auth values (PI_RESEARCH_API_KEY / _PROVIDER) are read directly from
 * process.env, NOT from the typed Config, so a key placed only in a config file
 * would otherwise be silently ignored. We bridge only when a key is absent from
 * the real environment, so real shell exports always win.
 */
function bridgeConfigEnv(explicitConfigPath?: string): { path: string; loaded: boolean } {
  const basePath = explicitConfigPath ?? getGlobalEnvFilePath();
  const cliOverlayPath = getInterfaceEnvFilePath('cli');
  let loaded = false;
  // Base first, then the cli overlay so overlay keys win — but neither clobbers a
  // real environment value.
  for (const filePath of [basePath, cliOverlayPath]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = parseDotEnv(fs.readFileSync(filePath, 'utf-8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined && (k.startsWith('PI_RESEARCH_') || k === 'STACKEXCHANGE_API_KEY' || k === 'GITHUB_TOKEN' || k === 'NVD_API_KEY')) {
          process.env[k] = v;
        }
      }
      loaded = true;
    } catch {
      // ignore unreadable file; fall through to the next
    }
  }
  return { path: basePath, loaded };
}

// ---------------------------------------------------------------------------
// Credential / model detection (no SDK init — cheap & safe for `status`)
// ---------------------------------------------------------------------------

export interface ResolvedConfigPaths {
  /** Global config file (~/.pi/research/config.env). */
  configEnv: string;
  /** Global config dir (~/.pi/research). */
  configDir: string;
  /** Per-interface overlay for THIS standalone CLI / agent skill (~/.pi/research/cli.env). */
  cliIfaceEnv: string;
  /** Per-interface overlay for the pi extension (~/.pi/research/pi.env). */
  piIfaceEnv: string;
  /** Per-interface overlay for the OpenClaw plugin (~/.pi/research/openclaw.env). */
  oclIfaceEnv: string;
  /** pi auth storage (~/.pi/agent/auth.json). */
  piAuth: string;
  /** pi model definitions (~/.pi/agent/models.json). */
  piModels: string;
  /** pi-research state dir (~/.pi/research/state). */
  piState: string;
}

function resolvedConfigPaths(): ResolvedConfigPaths {
  const agentDir = getAgentDir();
  const configDir = getGlobalConfigDir();
  return {
    configEnv: getGlobalEnvFilePath(),
    configDir,
    cliIfaceEnv: getInterfaceEnvFilePath('cli'),
    piIfaceEnv: getInterfaceEnvFilePath('pi'),
    oclIfaceEnv: getInterfaceEnvFilePath('openclaw'),
    piAuth: path.join(agentDir, 'auth.json'),
    piModels: path.join(agentDir, 'models.json'),
    piState: process.env['PI_RESEARCH_STATE_DIR'] ?? path.join(getGlobalConfigDir(), 'state'),
  };
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export interface CredentialDetection {
  /** Where credentials will come from once initResearchSDK runs. */
  source: 'explicit-env' | 'pi-config' | 'none';
  apiKeyConfigured: boolean;
  provider?: string;
  model?: string;
  modelFrom: 'PI_RESEARCH_MODEL' | 'config.env' | 'unset';
  piAuthPresent: boolean;
  piModelsPresent: boolean;
  /** A short, human-readable problem string, or undefined when ready. */
  problem?: string;
}

/**
 * Detect how the SDK will authenticate WITHOUT initializing it. Used both for
 * the `status` command and for the fast-fail pre-flight before every run.
 */
function detectCredentials(): CredentialDetection {
  const paths = resolvedConfigPaths();
  const piAuthPresent = fileExists(paths.piAuth);
  const piModelsPresent = fileExists(paths.piModels);

  const apiKey = process.env['PI_RESEARCH_API_KEY'];
  const providerEnv = process.env['PI_RESEARCH_PROVIDER'];
  const modelEnv = process.env['PI_RESEARCH_MODEL'];
  const modelConfig = getConfig(process.cwd(), 'cli').RESEARCH_MODEL;

  const model = modelEnv ?? modelConfig;
  const modelFrom = modelEnv ? 'PI_RESEARCH_MODEL' : modelConfig ? 'config.env' : 'unset';
  // Provider is either explicit, or inferred from a "provider/id" model string.
  const provider =
    providerEnv ?? (model && model.includes('/') ? model.slice(0, model.indexOf('/')) : undefined);

  // --- Explicit API-key path -------------------------------------------------
  if (apiKey) {
    if (!provider) {
      return {
        source: 'explicit-env',
        apiKeyConfigured: true,
        provider,
        model,
        modelFrom,
        piAuthPresent,
        piModelsPresent,
        problem:
          'PI_RESEARCH_API_KEY is set but no provider is configured. Set PI_RESEARCH_PROVIDER ' +
          '(e.g. openai) or use a "provider/model-id" value for PI_RESEARCH_MODEL.',
      };
    }
    if (!model) {
      return {
        source: 'explicit-env',
        apiKeyConfigured: true,
        provider,
        model,
        modelFrom,
        piAuthPresent,
        piModelsPresent,
        problem:
          'PI_RESEARCH_API_KEY is set but no model is configured. Set PI_RESEARCH_MODEL to a ' +
          '"provider/model-id" (e.g. openai/gpt-4o).',
      };
    }
    return {
      source: 'explicit-env',
      apiKeyConfigured: true,
      provider,
      model,
      modelFrom,
      piAuthPresent,
      piModelsPresent,
    };
  }

  // --- pi auth storage path --------------------------------------------------
  if (piAuthPresent) {
    // The SDK will resolve a model from the registry (models.json + PI_RESEARCH_MODEL).
    return {
      source: 'pi-config',
      apiKeyConfigured: true, // key lives in auth.json; SDK reads it
      provider,
      model,
      modelFrom,
      piAuthPresent,
      piModelsPresent,
    };
  }

  // --- Nothing configured ----------------------------------------------------
  return {
    source: 'none',
    apiKeyConfigured: false,
    provider,
    model,
    modelFrom,
    piAuthPresent,
    piModelsPresent,
    problem:
      'No model or API key is configured for pi-research. Provide credentials via environment ' +
      'variables (PI_RESEARCH_API_KEY + PI_RESEARCH_PROVIDER + PI_RESEARCH_MODEL) or, if you use ' +
      'pi, via ~/.pi/agent/auth.json.',
  };
}

/**
 * Build a ready-to-run summary block (config locations + current detection) used
 * in error messages and the `status` command so users always know where things
 * are configured.
 */
function configBlock(det: CredentialDetection, extraNote?: string): string {
  const paths = resolvedConfigPaths();
  const lines: string[] = [];
  lines.push('Configuration locations:');
  lines.push(`  • base config file:   ${paths.configEnv}`);
  lines.push(`  • cli overlay:        ${paths.cliIfaceEnv}  (optional; overrides base for this CLI / agent skill)`);
  lines.push(`  • env vars:           PI_RESEARCH_API_KEY / PI_RESEARCH_PROVIDER / PI_RESEARCH_MODEL`);
  lines.push(`  • pi auth storage:    ${paths.piAuth}`);
  lines.push(`  • pi models:          ${paths.piModels}`);
  lines.push('');
  lines.push('Detected:');
  lines.push(`  • credential source:  ${det.source}`);
  lines.push(`  • api key configured: ${det.apiKeyConfigured}`);
  lines.push(`  • provider:           ${det.provider ?? '(unset)'}`);
  lines.push(`  • model:              ${det.model ?? '(unset)'}  [from: ${det.modelFrom}]`);
  lines.push(`  • pi auth.json:       ${det.piAuthPresent ? 'present' : 'absent'}`);
  lines.push(`  • pi models.json:     ${det.piModelsPresent ? 'present' : 'absent'}`);
  if (extraNote) lines.push(`  • note:               ${extraNote}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

interface ResearchArgs {
  query: string;
  depth?: number;
  model?: string;
  excludeTools?: string[];
  initialLinks?: string[];
  json?: boolean;
}

/**
 * Research subcommand. Initializes the SDK, runs deep/quick research, prints the
 * markdown report to stdout, and always shuts down (even on failure).
 */
async function cmdResearch(args: ResearchArgs): Promise<number> {
  const det = detectCredentials();
  if (det.problem) {
    toStderr(`\nError: ${det.problem}\n\n${configBlock(det)}\n`);
    return EXIT.CONFIG;
  }

  const depth: 0 | 1 | 2 | 3 =
    (args.depth ?? getConfig(process.cwd(), 'cli').DEFAULT_RESEARCH_DEPTH) as 0 | 1 | 2 | 3;
  // An explicit --model wins over configured/PI_RESEARCH_MODEL for this run.
  const runModel = args.model ?? det.model;
  toStderr(`[pi-research] starting research (depth ${depth})${runModel ? ` with ${runModel}` : ''}…\n`);

  // Stream concise lifecycle progress to stderr so a long run is never silent.
  // Mirrors the headless observer pattern used by the pi-research SDK consumers.
  const observer: HeadlessObserverOptions = makeProgressObserver();

  let exit: number = EXIT.OK;
  try {
    await initResearchSDK({
      model: runModel,
      // Provider/key are read from process.env by the SDK; pass-through for clarity.
      apiKey: process.env['PI_RESEARCH_API_KEY'],
      provider: process.env['PI_RESEARCH_PROVIDER'],
      // Drive the SDK with the CLI's own resolved config (base config.env +
      // cli.env overlay), not the SDK's default base read.
      config: getConfig(process.cwd(), 'cli'),
      ignoreGlobalConfig: true,
    });

    let report = await runDeepResearch(args.query, {
      depth,
      observer,
      ...(args.excludeTools ? { excludeTools: args.excludeTools } : {}),
      ...(args.initialLinks ? { initialLinks: args.initialLinks } : {}),
    });

    // Optionally persist the report to a file (opt-in via
    // PI_RESEARCH_REPORT_EXPORT_ENABLED). The SDK is a pure library and does not
    // write files; the CLI front-end does, mirroring the pi/openclaw tool path.
    // The saved path is surfaced in BOTH the report text and the JSON output so
    // the calling agent can tell the user where the file is.
    let reportPath: string | null = null;
    const exportCfg = getConfig(process.cwd(), 'cli');
    if (exportCfg.RESEARCH_REPORT_EXPORT_ENABLED) {
      reportPath = await exportResearchReport(args.query, report, depth <= 1 ? 'quick' : 'deep', process.cwd(), exportCfg.RESEARCH_REPORT_EXPORT_DIR);
      if (reportPath) {
        report = appendExportMessage(report, reportPath);
        toStderr(`[pi-research] report saved to: ${reportPath}\n`);
      }
    }

    if (args.json) {
      toStdout(pretty({ ok: true, depth, report, ...(reportPath ? { reportPath } : {}) }));
    } else {
      toStdout(report.endsWith('\n') ? report : report + '\n');
    }
  } catch (err) {
    exit = reportError(err, 'research');
  } finally {
    await safeShutdown();
  }
  return exit;
}

/**
 * Knowledge-search subcommand (the second research tool). Returns a tri-state
 * result; `found: 'no'`/`'maybe'` tells the caller to follow up with live
 * research.
 */
async function cmdKnowledge(queries: string[], json?: boolean): Promise<number> {
  const det = detectCredentials();
  if (det.problem) {
    toStderr(`\nError: ${det.problem}\n\n${configBlock(det)}\n`);
    return EXIT.CONFIG;
  }

  const mode = getConfig(process.cwd(), 'cli').KNOWLEDGE_STORE_MODE;
  if (mode === 'none') {
    const paths = resolvedConfigPaths();
    const msg =
      'Knowledge store is disabled (PI_RESEARCH_KNOWLEDGE_STORE_MODE=none). ' +
      "Set it to 'project' or 'global' to enable local knowledge search.\n\n" +
      `Configure in:\n  ${paths.configEnv}\n  ${paths.cliIfaceEnv}  (cli overlay)\n  or via PI_RESEARCH_KNOWLEDGE_STORE_MODE env var`;
    if (json) toStdout(pretty({ found: 'no', text: msg, configured: false }));
    else toStderr(`\n[pi-research] ${msg}\n`);
    return EXIT.CONFIG;
  }

  let result: KnowledgeSearchResult;
  let exit: number = EXIT.OK;
  try {
    await initResearchSDK({
      model: det.model,
      apiKey: process.env['PI_RESEARCH_API_KEY'],
      provider: process.env['PI_RESEARCH_PROVIDER'],
      config: getConfig(process.cwd(), 'cli'),
      ignoreGlobalConfig: true,
    });
    toStderr(`[pi-research] searching knowledge store (${queries.length} query/${queries.length === 1 ? '' : 's'})…\n`);
    result = await searchKnowledge(queries);
  } catch (err) {
    return reportError(err, 'knowledge search');
  } finally {
    await safeShutdown();
  }

  if (json) {
    toStdout(pretty(result));
  } else {
    toStdout((result.text.endsWith('\n') ? result.text : result.text + '\n'));
  }
  return exit;
}

/**
 * Status subcommand: print where things are and whether the skill is ready to
 * run, without initializing the SDK. Machine-readable with --json.
 */
async function cmdStatus(json?: boolean): Promise<number> {
  const det = detectCredentials();
  const paths = resolvedConfigPaths();
  const cfg = getConfig(process.cwd(), 'cli');
  const summary = {
    package: '@lincoln504/pi-research',
    version: PKG_VERSION,
    cli: `node ${process.argv[1]}`,
    ready: !det.problem,
    credentials: {
      source: det.source,
      apiKeyConfigured: det.apiKeyConfigured,
      provider: det.provider ?? null,
      model: det.model ?? null,
      modelFrom: det.modelFrom,
      problem: det.problem ?? null,
    },
    knowledgeStoreMode: cfg.KNOWLEDGE_STORE_MODE,
    defaultDepth: cfg.DEFAULT_RESEARCH_DEPTH,
    paths,
  };

  if (json) {
    toStdout(pretty(summary));
    return EXIT.OK;
  }

  toStdout(`pi-research ${PKG_VERSION}\n`);
  toStdout(`ready: ${summary.ready ? 'yes' : 'no'}\n\n`);
  toStdout(configBlock(det, summary.ready ? undefined : '— fix the problem above, then re-run.') + '\n');
  toStdout(`\nknowledge store mode: ${cfg.KNOWLEDGE_STORE_MODE}   (default depth: ${cfg.DEFAULT_RESEARCH_DEPTH})\n`);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// Error reporting & shutdown
// ---------------------------------------------------------------------------

/** Distinguish setup errors from runtime errors and print a clean, located message. */
function reportError(err: unknown, what: string): number {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Auth / model / config-shaped errors → CONFIG exit + config block.
  const isConfigError =
    lower.includes('no llm model available') ||
    lower.includes('not found in pi') ||
    lower.includes('no api key') ||
    lower.includes('provider must be specified') ||
    lower.includes('invalid model string') ||
    lower.includes('auth') ||
    lower.includes('unauthorized') ||
    lower.includes('api key');

  if (isConfigError) {
    toStderr(`\nError: pi-research ${what} failed: ${msg}\n\n${configBlock(detectCredentials())}\n`);
    return EXIT.CONFIG;
  }

  // Rate limits are operational, not fatal setup problems.
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    toStderr(`\nError: pi-research ${what} halted: provider rate limit reached. Wait a moment and retry.\n  ${msg}\n`);
    return EXIT.SOFTWARE;
  }

  toStderr(`\nError: pi-research ${what} failed: ${msg}\n`);
  if (process.env['PI_RESEARCH_DEBUG'] === 'true' && err instanceof Error && err.stack) {
    toStderr('\n' + err.stack + '\n');
  }
  return EXIT.SOFTWARE;
}

/**
 * Best-effort SDK shutdown that never throws.
 * Bounded by SHUTDOWN_TIMEOUT_MS: WASM threads (ONNX/embedding model), LanceDB
 * connections, and the browser orphan sweep can all outlast their own internal
 * timeouts. We must not let the CLI hang forever on exit.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function safeShutdown(): Promise<void> {
  try {
    await Promise.race([
      shutdownResearchSDK(),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          toStderr('[pi-research] shutdown timeout — forcing exit\n');
          resolve();
        }, SHUTDOWN_TIMEOUT_MS),
      ),
    ]);
  } catch {
    // Swallow — nothing actionable for the caller, and we must not mask the real result.
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string;
  research?: ResearchArgs;
  knowledge?: { queries: string[]; json?: boolean };
  status?: { json?: boolean };
  configPath?: string;
  json?: boolean;
}

function buildHelp(): string {
  const p = resolvedConfigPaths();
  return `${BINARY_NAME} v${PKG_VERSION} — multi-agent web research (pi-research SDK)

USAGE
  ${BINARY_NAME} <command> [options]

COMMANDS
  research  "<query>"            Run multi-agent web research (default depth: 1).
    --depth <1|2|3>              1 = fast/default, 2 = deep, 3 = exhaustive.
    --model <provider/id>        Override the model for this run.
    --exclude-tools <a,b>        Disable internal tools (e.g. security,stackexchange).
    --initial-links <url ...>    Seed URLs to investigate first (-- ends options).
    --config <path>              Read additional config from this file.
    --json                       Emit a JSON object instead of a markdown report.

  knowledge "<q1>" ["<q2>" ...]  Search local knowledge store before live research.
    --config <path>              Read additional config from this file.
    --json                       Emit a JSON object.

  status                         Show detected config, model/key, and readiness.
    --json                       Emit a JSON object.

  help, --help, -h               Show this help.

CONFIGURE
  Credentials are read in this order (later entries win):

    base config:  ${p.configEnv}
    cli overlay:  ${p.cliIfaceEnv}   (optional; this CLI / agent skill only)
    env vars:     PI_RESEARCH_API_KEY  PI_RESEARCH_PROVIDER  PI_RESEARCH_MODEL
    pi auth:      ${p.piAuth}
    pi models:    ${p.piModels}

  Other front-ends have their own optional overlay files:
    pi extension: ${p.piIfaceEnv}
    OpenClaw:     ${p.oclIfaceEnv}

  Knowledge store (global by default; set to 'project' to scope per-directory,
  or 'none' to disable):
    PI_RESEARCH_KNOWLEDGE_STORE_MODE=none  (or project)
    in ${p.configEnv}

  Run \`${BINARY_NAME} status\` to see exactly what is detected.

EXIT CODES
  0  success
  64 bad arguments
  78 not configured — message prints the exact locations to fix
  70 runtime error (network, provider, internal)
`;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  const args = argv.slice(2);

  if (args.length === 0) {
    out.command = 'help';
    return out;
  }

  const cmd = args[0];
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    out.command = 'help';
    return out;
  }
  if (cmd === '-v' || cmd === '--version') {
    out.command = 'version';
    return out;
  }

  const rest = args.slice(1);

  if (cmd === 'status') {
    const json = rest.includes('--json');
    let configPath: string | undefined;
    const ci = rest.indexOf('--config');
    if (ci !== -1 && rest[ci + 1]) configPath = rest[ci + 1];
    out.command = 'status';
    out.status = { json };
    out.configPath = configPath;
    return out;
  }

  if (cmd === 'knowledge') {
    const positional: string[] = [];
    let json = false;
    let configPath: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--json') json = true;
      else if (a === '--config' && rest[i + 1]) configPath = rest[++i];
      else if (a?.startsWith('--')) {
        throw new UsageError(`unknown option for knowledge: ${a}`);
      } else if (a !== undefined) {
        positional.push(a);
      }
    }
    if (positional.length === 0) throw new UsageError('knowledge requires at least one query.');
    if (positional.length > 5) throw new UsageError('knowledge accepts at most 5 queries.');
    out.command = 'knowledge';
    out.knowledge = { queries: positional, json };
    out.configPath = configPath;
    return out;
  }

  if (cmd === 'research') {
    const r: ResearchArgs = { query: '' };
    const initialLinks: string[] = [];
    let depth: number | undefined;
    let model: string | undefined;
    let excludeTools: string[] | undefined;
    let json = false;
    let configPath: string | undefined;
    const positional: string[] = [];

    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--') {
        // Everything after -- is the query / positional.
        positional.push(...rest.slice(i + 1).filter((x): x is string => x !== undefined));
        break;
      }
      if (a === '--depth') {
        const v = rest[++i];
        const n = v === undefined ? NaN : parseInt(v, 10);
        if (isNaN(n) || n < 0 || n > 3) throw new UsageError('--depth must be an integer 0–3.');
        depth = n;
      } else if (a === '--model') {
        model = rest[++i];
        if (!model) throw new UsageError('--model requires a value.');
      } else if (a === '--exclude-tools') {
        const v = rest[++i];
        excludeTools = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      } else if (a === '--initial-links') {
        // Consume until the next flag or end.
        let j = i + 1;
        while (j < rest.length && !rest[j]?.startsWith('--')) {
          const link = rest[j];
          if (link) initialLinks.push(link);
          j++;
        }
        i = j - 1;
      } else if (a === '--config') {
        configPath = rest[++i];
        if (!configPath) throw new UsageError('--config requires a path.');
      } else if (a === '--json') {
        json = true;
      } else if (a?.startsWith('--')) {
        throw new UsageError(`unknown option: ${a}`);
      } else if (a !== undefined) {
        positional.push(a);
      }
    }

    if (positional.length === 0 && initialLinks.length === 0) {
      throw new UsageError('research requires a query (or --initial-links).');
    }
    r.query = positional.join(' ').trim();
    r.depth = depth;
    r.model = model;
    r.excludeTools = excludeTools;
    r.initialLinks = initialLinks.length ? initialLinks : undefined;
    r.json = json;
    out.command = 'research';
    out.research = r;
    out.configPath = configPath;
    return out;
  }

  throw new UsageError(`unknown command "${cmd}". Run \`${BINARY_NAME} help\`.`);
}

export class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  // Register signal handlers so SIGINT/SIGTERM always trigger SDK shutdown
  // before the process exits. safeShutdown() is idempotent — safe to call
  // before SDK init (it no-ops) and safe to call from multiple signals.
  let _signalCleanupDone = false;
  const onSignal = (sig: string) => {
    if (_signalCleanupDone) return;
    _signalCleanupDone = true;
    toStderr(`\n[pi-research] ${sig} — cleaning up…\n`);
    // Fire-and-forget: we can't await here, but safeShutdown swallows errors
    // and the finally blocks in each command handler also call it.
    void safeShutdown().finally(() => process.exit(EXIT.SOFTWARE));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toStderr(`\nError: ${msg}\n\n${buildHelp()}`);
    return EXIT.USAGE;
  }

  // Bridge config.env → process.env for commands that touch the engine.
  // help/version are pure and need no credentials/config.
  const noBridge = new Set(['help', 'version']);
  if (!noBridge.has(parsed.command ?? '')) {
    bridgeConfigEnv(parsed.configPath);
  }

  switch (parsed.command) {
    case 'help':
      toStdout(buildHelp());
      return EXIT.OK;
    case 'version':
      toStdout(`${BINARY_NAME} ${PKG_VERSION}\n`);
      return EXIT.OK;
    case 'status':
      return cmdStatus(parsed.status?.json);
    case 'knowledge':
      return cmdKnowledge(parsed.knowledge!.queries, parsed.knowledge!.json);
    case 'research':
      return cmdResearch(parsed.research!);
    default:
      toStdout(buildHelp());
      return EXIT.OK;
  }
}

// ---------------------------------------------------------------------------
// Entry-point guard
// ---------------------------------------------------------------------------

// Only run when this module is the direct entry point (node cli.mjs <args>),
// not when it is imported by a test or another module.  We compare the
// resolved on-disk path of this module's URL against process.argv[1].
const _isMain = (() => {
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (_isMain) {
  // Top-level entry. Never let an unhandled rejection escape — print a clean error.
  // Use process.exit() (not process.exitCode) so WASM threads, LanceDB handles,
  // and other native resources do not keep the event loop alive after work is done.
  // Flush both streams first to avoid truncating buffered output.
  const flushAndExit = (code: number) => {
    process.stdout.write('', () => {
      process.stderr.write('', () => {
        process.exit(code);
      });
    });
  };

  main(process.argv)
    .then(flushAndExit)
    .catch((err) => {
      toStderr(`\nError: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      flushAndExit(EXIT.SOFTWARE);
    });
}
