/**
 * pi-research — standalone CLI
 *
 * A thin, dependency-free command line over the pi-research programmatic SDK
 * (src/sdk.ts). It lets any tool — Claude, Cursor, a shell script, CI — run
 * multi-agent web research without the pi CLI or TUI.
 *
 *   pi-research research "<query>" [--depth N] [--model provider/id]
 *   pi-research knowledge "<q>" ["<q2>" ...]
 *   pi-research knowledge-config [set <none|project|global>]
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
import { validateAndSanitizeQuery } from './utils/input-validation.ts';
import { validateInitialLink, MAX_INITIAL_LINKS } from './utils/url-utils.ts';
import { exportResearchReport, appendExportMessage } from './utils/research-export.ts';
import { getConfig, getGlobalConfigDir, getGlobalEnvFilePath, getInterfaceEnvFilePath, saveConfig, resetConfig, describeKnowledgeStoreMode, isProjectScopedKey, parseDotEnv } from './config.ts';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { buildModelRegistry, safeGetAvailable } from './core/llm/model-registry-factory.ts';

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
export function bridgeConfigEnv(explicitConfigPath?: string): { path: string; loaded: boolean } {
  const basePath = explicitConfigPath ?? getGlobalEnvFilePath();
  const cliOverlayPath = getInterfaceEnvFilePath('cli');
  let loaded = false;
  // Merge base then overlay into one map FIRST (overlay wins), and only then
  // promote into process.env. Promoting per-file would invert the documented
  // precedence: the base file's key would land in process.env on the first
  // iteration and the "don't clobber the real environment" guard would then
  // block the overlay's value — cli.env could never override config.env.
  const merged: Record<string, string> = {};
  for (const filePath of [basePath, cliOverlayPath]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      Object.assign(merged, parseDotEnv(fs.readFileSync(filePath, 'utf-8')));
      loaded = true;
    } catch {
      // ignore unreadable file; fall through to the next
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    // Skip per-directory (project-scoped) keys: promoting them into process.env would make
    // config.env out-rank the per-directory registry, defeating a per-cwd override. They are
    // still applied as a lower-precedence file layer by getConfig()/loadEnvFiles().
    if (isProjectScopedKey(k)) continue;
    if (process.env[k] === undefined && (k.startsWith('PI_RESEARCH_') || k === 'STACKEXCHANGE_API_KEY' || k === 'GITHUB_TOKEN' || k === 'NVD_API_KEY')) {
      process.env[k] = v;
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
  /** pi's key file (~/.pi/agent/auth.json), part of pi's configuration. */
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

/**
 * Are keys usable from pi's configuration? Answered by pi's OWN semantics, not
 * by file presence: build pi's model registry (two small JSON reads — no
 * services, network, or native deps) and ask for the authed subset. That check
 * (`hasConfiguredAuth`) covers every source the registry consults at call
 * time: an auth.json provider entry (api-key or OAuth), a per-provider apiKey
 * embedded in models.json (env-template aware), and provider env vars like
 * OPENAI_API_KEY. File presence alone is neither necessary (keys can live in
 * models.json / env with no auth.json) nor sufficient (auth.json can be `{}`).
 */
function piKeysAvailable(piAuthPresent: boolean): boolean {
  try {
    return safeGetAvailable(buildModelRegistry(undefined, undefined)).length > 0;
  } catch {
    // Cannot inspect (e.g. malformed models.json) — fall back to file
    // presence: pre-flight must never block a possibly-working setup; the run
    // itself reports the precise error.
    return piAuthPresent;
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
  const piKeysUsable = piKeysAvailable(piAuthPresent);

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

  // --- pi configuration path (key from auth.json, models.json, or provider env) ---
  if (piKeysUsable) {
    // Keys come from pi's configuration, but the MODEL must be configured
    // explicitly: the standalone CLI / agent skill run only on the configured
    // model — they never follow the model selected inside the pi extension, and
    // silently falling back to the registry's first authed entry picks a model
    // nobody chose. Fail fast here (pre-flight, before any SDK init).
    if (!model) {
      return {
        source: 'pi-config',
        apiKeyConfigured: true,
        provider,
        model,
        modelFrom,
        piAuthPresent,
        piModelsPresent,
        problem:
          'pi credentials were found (in pi\'s configuration), but no research model is configured. ' +
          'The standalone CLI / agent skill run only on an explicitly configured model — they do not ' +
          'follow the model selected inside the pi extension. Set PI_RESEARCH_MODEL to a ' +
          '"provider/model-id" (in the environment, or in config.env / cli.env below).',
      };
    }
    return {
      source: 'pi-config',
      apiKeyConfigured: true, // key lives in pi's configuration; the SDK reads it at call time
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
      "pi, via pi's configuration (a provider entry in ~/.pi/agent/auth.json, or a per-provider " +
      'apiKey in ~/.pi/agent/models.json).',
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
  lines.push(`  • pi config (keys):   ${paths.piAuth}`);
  lines.push(`  • pi config (models): ${paths.piModels}`);
  lines.push('');
  lines.push('Detected:');
  lines.push(`  • credential source:  ${det.source}`);
  lines.push(`  • api key configured: ${det.apiKeyConfigured}`);
  lines.push(`  • provider:           ${det.provider ?? '(unset — inferred from a provider/model-id model)'}`);
  lines.push(`  • model:              ${det.model ? `${det.model}  [from: ${det.modelFrom}]` : '(not set — set PI_RESEARCH_MODEL, required)'}`);
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
    if (args.json) toStdout(pretty({ ok: false, error: det.problem, exitCode: EXIT.CONFIG }));
    else toStderr(`\nError: ${det.problem}\n\n${configBlock(det)}\n`);
    return EXIT.CONFIG;
  }

  // Apply the same length/whitespace/dangerous-content gate the pi tool path enforces.
  // The CLI (and the skill launcher that forwards to it) otherwise reached the orchestrator
  // with an unbounded or whitespace-only query — parseArgs only rejects a fully empty one.
  let query: string;
  try {
    query = validateAndSanitizeQuery(args.query);
  } catch (e) {
    const vmsg = e instanceof Error ? e.message : String(e);
    if (args.json) toStdout(pretty({ ok: false, error: vmsg, exitCode: EXIT.USAGE }));
    else toStderr(`\nError: ${vmsg}\n`);
    return EXIT.USAGE;
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

    let report = await runDeepResearch(query, {
      depth,
      observer,
      ...(args.excludeTools ? { excludeTools: args.excludeTools } : {}),
      ...(args.initialLinks ? { initialLinks: args.initialLinks } : {}),
    });

    // Optionally persist the report to a file (opt-in via
    // PI_RESEARCH_REPORT_EXPORT_ENABLED). The SDK is a pure library and does not
    // write files; the CLI front-end does, mirroring the pi tool path.
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
    exit = reportError(err, 'research', args.json);
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
    if (json) { toStdout(pretty({ ok: false, error: det.problem, exitCode: EXIT.CONFIG })); return EXIT.CONFIG; }
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
    return reportError(err, 'knowledge search', json);
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

/**
 * knowledge-config subcommand: show or set the per-directory knowledge-store mode.
 *
 * `set` persists the mode for the CURRENT working directory via the same registry writer the
 * interactive /research-config menu uses (saveConfig scope 'local' → ~/.pi/research/state/
 * project-settings.json keyed by the normalized cwd), then resetConfig() so the new value is
 * what the very next getConfig() returns. This is the supported way for an agent to change the
 * setting on the user's behalf without hand-editing the locked registry JSON. A machine-wide
 * default is set instead via the PI_RESEARCH_KNOWLEDGE_STORE_MODE env var (per-run) or config.env.
 */
async function cmdKnowledgeConfig(kc: NonNullable<ParsedArgs['knowledgeConfig']>): Promise<number> {
  const cwd = process.cwd();

  if (kc.action === 'set') {
    const before = getConfig(cwd, 'cli').KNOWLEDGE_STORE_MODE;
    const cfg = { ...getConfig(cwd, 'cli'), KNOWLEDGE_STORE_MODE: kc.mode! };
    // Persist ONLY the knowledge-store mode for this directory — not the whole local-key set —
    // so an unrelated per-directory DEFAULT_RESEARCH_DEPTH isn't frozen as a side effect.
    saveConfig(cfg, 'local', cwd, ['PI_RESEARCH_KNOWLEDGE_STORE_MODE']); // per-directory registry write
    resetConfig();                 // drop the cached config so `after` re-resolves from disk
    const info = describeKnowledgeStoreMode(cwd, 'cli');
    // The write always persists to the registry, but a real env var out-ranks the registry, so
    // the EFFECTIVE mode can still differ from what was requested. Surface that instead of
    // silently reporting a no-op.
    const overridden = info.mode !== kc.mode;
    if (kc.json) {
      toStdout(pretty({ command: 'knowledge-config', action: 'set', requested: kc.mode, previous: before, saved: true, effectiveOverriddenBy: overridden ? info.origin : null, ...info, cwd }));
      return EXIT.OK;
    }
    toStdout(
      `knowledge store mode for this directory: ${before} -> ${kc.mode}  (saved per-directory)\n` +
      `  scope:   ${kc.mode === 'none' ? 'disabled here' : kc.mode === 'project' ? 'this directory only' : 'shared across all directories'}\n` +
      `  saved:   per-directory (${cwd})\n` +
      `  db dir:  ${info.dbDir}\n` +
      (overridden
        ? `\nNOTE: the effective mode here is still '${info.mode}' because a higher-precedence ${info.origin} overrides it. Clear that source for this setting to take effect.\n`
        : ''),
    );
    return EXIT.OK;
  }

  // show
  const info = describeKnowledgeStoreMode(cwd, 'cli');
  if (kc.json) {
    toStdout(pretty({ command: 'knowledge-config', action: 'show', ...info, cwd }));
    return EXIT.OK;
  }
  toStdout(
    `knowledge store mode: ${info.mode}   (source: ${info.origin})\n` +
    `  scope:   ${info.mode === 'none' ? 'disabled here' : info.mode === 'project' ? 'this directory only' : 'shared across all directories'}\n` +
    `  db dir:  ${info.dbDir}\n` +
    `\nchange it for THIS directory:  ${BINARY_NAME} knowledge-config set <none|project|global>\n` +
    `change the machine-wide default: set PI_RESEARCH_KNOWLEDGE_STORE_MODE=<mode> in ${resolvedConfigPaths().configEnv}\n`,
  );
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// skill subcommand
// ---------------------------------------------------------------------------

/**
 * skill subcommand: install / uninstall / inspect the pi-research Agent Skill in
 * the coding agents on this machine (Claude, OpenAI Codex CLI, OpenClaw). This is
 * the CLI equivalent of the pi extension's `/research-config → Install in External
 * Agents`, for standalone users who installed the engine with `npm install -g` and
 * never open the interactive pi extension. It drives the SAME skill-installer
 * library the TUI uses, so the guarantees are identical: only agents whose config
 * dir already exists are targeted, a foreign skill already in the slot is never
 * clobbered, and every link/copy is manifest-tracked so uninstall removes exactly
 * what was created.
 */
async function cmdSkill(s: NonNullable<ParsedArgs['skill']>): Promise<number> {
  const {
    installSkill, uninstallSkill, skillInstallCandidates, skillUninstallCandidates,
    detectHarnesses, SKILL_AGENT_TARGETS,
  } = await import('./skill-install/skill-installer.ts');
  const isTarget = (id: string): boolean =>
    (SKILL_AGENT_TARGETS as readonly string[]).includes(id);

  if (s.action === 'status') {
    const agents = detectHarnesses().filter((d) => isTarget(d.id));
    if (s.json) {
      toStdout(pretty({
        command: 'skill', action: 'status',
        agents: agents.map((d) => ({ id: d.id, label: d.label, present: d.present, installed: d.installed, path: d.absSkillPath })),
      }));
      return EXIT.OK;
    }
    toStdout(`pi-research agent skill — install status\n\n`);
    for (const d of agents) {
      const state = !d.present ? 'agent not detected'
        : d.installed === 'none' ? 'not installed'
        : d.installed === 'foreign' ? 'a different skill occupies this slot — left untouched'
        : `installed (${d.installed === 'owned-copy' ? 'copy' : 'symlink'})`;
      const loc = d.installed === 'owned-symlink' || d.installed === 'owned-copy' ? `  → ${d.absSkillPath}` : '';
      toStdout(`  ${d.label.padEnd(18)} ${state}${loc}\n`);
    }
    toStdout(`\ninstall:   ${BINARY_NAME} skill install\nuninstall: ${BINARY_NAME} skill uninstall\n`);
    return EXIT.OK;
  }

  if (s.action === 'install') {
    const candidates = skillInstallCandidates();
    if (candidates.length === 0) {
      const note = 'No supported coding agents detected under $HOME (looked for Claude, OpenAI Codex CLI, OpenClaw). Set one up first, then re-run.';
      if (s.json) { toStdout(pretty({ command: 'skill', action: 'install', dryRun: !!s.dryRun, results: [], note })); return EXIT.OK; }
      toStderr(`\n[pi-research] ${note}\n`);
      return EXIT.OK;
    }
    let results;
    try {
      results = installSkill(candidates.map((d) => d.id), { dryRun: s.dryRun, copy: s.copy });
    } catch (err) {
      return reportError(err, 'skill install', s.json);
    }
    // The skill runs only on an explicitly configured model — if none is set yet,
    // say so right here, at the moment of install (mirrors the TUI install action).
    const skillModel =
      process.env['PI_RESEARCH_MODEL'] ?? getConfig(process.cwd(), 'cli').RESEARCH_MODEL;
    if (s.json) {
      toStdout(pretty({ command: 'skill', action: 'install', dryRun: !!s.dryRun, results, modelConfigured: Boolean(skillModel) }));
    } else {
      toStdout(`pi-research agent skill — ${s.dryRun ? 'install (dry run)' : 'install'}\n\n`);
      for (const r of results) toStdout(`  ${r.tool.padEnd(10)} ${describeInstall(r)}\n`);
      toStdout(`\nThe skill activates automatically — ask the agent to research something.\n`);
      if (!skillModel) {
        toStdout(
          `\nRequired: set PI_RESEARCH_MODEL=provider/model-id in ${resolvedConfigPaths().configEnv}\n` +
          `(or as an env var) — the skill runs only on this configured model, not your pi\n` +
          `session model. Verify with: ${BINARY_NAME} status\n`
        );
      }
    }
    return results.some((r) => r.status === 'error') ? EXIT.SOFTWARE : EXIT.OK;
  }

  // uninstall
  const candidates = skillUninstallCandidates();
  if (candidates.length === 0) {
    const note = 'No pi-research skill installs found to remove.';
    if (s.json) { toStdout(pretty({ command: 'skill', action: 'uninstall', dryRun: !!s.dryRun, results: [], note })); return EXIT.OK; }
    toStdout(`\n[pi-research] ${note}\n`);
    return EXIT.OK;
  }
  let results;
  try {
    results = uninstallSkill(candidates.map((d) => d.id), { dryRun: s.dryRun });
  } catch (err) {
    return reportError(err, 'skill uninstall', s.json);
  }
  if (s.json) {
    toStdout(pretty({ command: 'skill', action: 'uninstall', dryRun: !!s.dryRun, results }));
  } else {
    toStdout(`pi-research agent skill — ${s.dryRun ? 'uninstall (dry run)' : 'uninstall'}\n\n`);
    for (const r of results) toStdout(`  ${r.tool.padEnd(10)} ${describeUninstall(r)}\n`);
  }
  return results.some((r) => r.status === 'error') ? EXIT.SOFTWARE : EXIT.OK;
}

function describeInstall(r: { status: string; type?: string; path: string; message?: string }): string {
  switch (r.status) {
    case 'installed': return `${r.type === 'copy' ? 'copied' : 'symlinked'} → ${r.path}`;
    case 'already-installed': return `already installed → ${r.path}`;
    case 'planned': return `would ${r.type === 'copy' ? 'copy' : 'symlink'} → ${r.path}`;
    case 'skipped-foreign': return 'a different skill occupies this slot — left untouched';
    case 'error': return `failed: ${r.message ?? 'unknown error'}`;
    default: return r.status;
  }
}

function describeUninstall(r: { status: string; path: string; message?: string }): string {
  switch (r.status) {
    case 'removed': return `removed → ${r.path}`;
    case 'planned': return `would remove → ${r.path}`;
    case 'not-present': return 'nothing installed';
    case 'skipped-foreign': return 'not ours — left untouched';
    case 'error': return `failed: ${r.message ?? 'unknown error'}`;
    default: return r.status;
  }
}

// ---------------------------------------------------------------------------
// Error reporting & shutdown
// ---------------------------------------------------------------------------

/** Distinguish setup errors from runtime errors and print a clean, located message. */
function reportError(err: unknown, what: string, json?: boolean): number {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Auth / model / config-shaped errors → CONFIG exit + config block.
  const isConfigError =
    lower.includes('no llm model available') ||
    lower.includes('not found in pi') ||
    lower.includes('no api key') ||
    lower.includes('provider must be specified') ||
    lower.includes('invalid model string') ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('api key');

  const isRateLimit = lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests');
  const exitCode = isConfigError ? EXIT.CONFIG : EXIT.SOFTWARE;

  // --json: emit a structured error on stdout so a machine consumer never has to
  // special-case plain-text stderr. Mirrors the { ok: true, ... } success shape.
  if (json) {
    const payload: Record<string, unknown> = { ok: false, error: msg, exitCode };
    if (process.env['PI_RESEARCH_DEBUG'] === 'true' && err instanceof Error && err.stack) {
      payload['stack'] = err.stack;
    }
    toStdout(pretty(payload));
    return exitCode;
  }

  if (isConfigError) {
    toStderr(`\nError: pi-research ${what} failed: ${msg}\n\n${configBlock(detectCredentials())}\n`);
    return exitCode;
  }
  // Rate limits are operational, not fatal setup problems.
  if (isRateLimit) {
    toStderr(`\nError: pi-research ${what} halted: provider rate limit reached. Wait a moment and retry.\n  ${msg}\n`);
    return exitCode;
  }
  toStderr(`\nError: pi-research ${what} failed: ${msg}\n`);
  if (process.env['PI_RESEARCH_DEBUG'] === 'true' && err instanceof Error && err.stack) {
    toStderr('\n' + err.stack + '\n');
  }
  return exitCode;
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
  knowledgeConfig?: { action: 'show' | 'set'; mode?: 'none' | 'project' | 'global'; json?: boolean };
  status?: { json?: boolean };
  skill?: { action: 'install' | 'uninstall' | 'status'; json?: boolean; dryRun?: boolean; copy?: boolean };
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
    --depth <0-3>                0 = quick, 1 = normal (default), 2 = deep, 3 = ultra.
    --model <provider/id>        Override the model for this run.
    --exclude-tools <a,b>        Disable internal tools (e.g. security_search,stackexchange).
    --initial-links <url ...>    Seed URLs to investigate first; requires a query (-- ends options).
    --config <path>              Use this config file instead of the base config.env.
    --json                       Emit a JSON object instead of a markdown report.

  knowledge "<q1>" ["<q2>" ...]  Search local knowledge store before live research (up to 5 queries).
    --config <path>              Use this config file instead of the base config.env.
    --json                       Emit a JSON object.

  knowledge-config [show]        Show the knowledge-store mode for this directory + its source.
    --config <path>              Use this config file instead of the base config.env.
    --json                       Emit a JSON object.
  knowledge-config set <mode>    Set the mode for THIS directory (none | project | global);
                                 persisted per-directory. Takes effect on the next run.

  status                         Show detected config, model/key, and readiness.
    --config <path>              Use this config file instead of the base config.env.
    --json                       Emit a JSON object.

  skill [status]                 Show where the agent skill is installed across your coding agents.
  skill install                  Install the skill into detected agents (Claude, Codex, OpenClaw).
    --copy | --dry-run | --json  Copy instead of symlink; plan only; JSON output.
  skill uninstall                Remove the skill from agents where pi-research installed it.
    --dry-run | --json           Plan only; JSON output.

  help, --help, -h               Show this help.

CONFIGURE
  Credentials are resolved in this order (first match wins):

    env vars:            PI_RESEARCH_API_KEY  PI_RESEARCH_PROVIDER  PI_RESEARCH_MODEL
    cli overlay:         ${p.cliIfaceEnv}   (optional; this CLI / agent skill only)
    base config:         ${p.configEnv}
    pi config (keys):    ${p.piAuth}
    pi config (models):  ${p.piModels}

  A model is REQUIRED: set PI_RESEARCH_MODEL to a "provider/model-id". This CLI and
  the agent skill run only on that configured model — they do not follow the model
  selected inside the pi extension.

  The pi extension has its own optional overlay file:
    pi extension: ${p.piIfaceEnv}

  Knowledge store — ON by default in every directory (mode 'global', one shared store).
    per-directory:  ${BINARY_NAME} knowledge-config set <none|project|global>
    machine-wide:   PI_RESEARCH_KNOWLEDGE_STORE_MODE=<mode>  in ${p.configEnv}
    'project' scopes the store to the current directory; 'none' disables it here.

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

  if (cmd === 'knowledge-config') {
    let json = false;
    let configPath: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--json') json = true;
      else if (a === '--config' && rest[i + 1]) configPath = rest[++i];
      else if (a?.startsWith('--')) {
        throw new UsageError(`unknown option for knowledge-config: ${a}`);
      } else if (a !== undefined) {
        positional.push(a);
      }
    }
    const action = positional[0] ?? 'show';
    if (action === 'show') {
      out.command = 'knowledge-config';
      out.knowledgeConfig = { action: 'show', json };
      out.configPath = configPath;
      return out;
    }
    if (action === 'set') {
      const mode = positional[1];
      if (mode === undefined) {
        throw new UsageError('knowledge-config set requires a mode: none | project | global.');
      }
      if (mode !== 'none' && mode !== 'project' && mode !== 'global') {
        throw new UsageError(`invalid knowledge store mode "${mode}". Use one of: none | project | global.`);
      }
      if (positional.length > 2) {
        throw new UsageError(`unexpected argument "${positional[2]}" after "knowledge-config set ${mode}".`);
      }
      out.command = 'knowledge-config';
      out.knowledgeConfig = { action: 'set', mode, json };
      out.configPath = configPath;
      return out;
    }
    throw new UsageError(`unknown knowledge-config action "${action}". Use: show | set <none|project|global>.`);
  }

  if (cmd === 'skill') {
    let json = false;
    let dryRun = false;
    let copy = false;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--json') json = true;
      else if (a === '--dry-run') dryRun = true;
      else if (a === '--copy') copy = true;
      else if (a?.startsWith('--')) {
        throw new UsageError(`unknown option for skill: ${a}`);
      } else if (a !== undefined) {
        positional.push(a);
      }
    }
    const action = positional[0] ?? 'status';
    if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
      throw new UsageError(`unknown skill action "${action}". Use: status | install | uninstall.`);
    }
    if (positional.length > 1) {
      throw new UsageError(`unexpected argument "${positional[1]}" after "skill ${action}".`);
    }
    out.command = 'skill';
    out.skill = { action, json, dryRun, copy };
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
        // Consume until the next flag or end. Validate each entry: these are templated
        // verbatim into the researcher's "investigate these first" evidence block, so
        // (like the query) they must be bounded and shape-checked — reject non-http(s)
        // or oversized tokens and cap the count so a caller can't inject arbitrary
        // instructions framed as trusted seed evidence or blow the prompt budget.
        // Shares validateInitialLink with the research tool's initialLinks
        // parameter (research-tool-definition.ts) so the two paths cannot drift.
        let j = i + 1;
        while (j < rest.length && !rest[j]?.startsWith('--')) {
          const link = rest[j];
          if (link) {
            const linkError = validateInitialLink(link);
            if (linkError) throw new UsageError(`--initial-links: ${linkError}.`);
            if (initialLinks.length >= MAX_INITIAL_LINKS) throw new UsageError(`--initial-links: at most ${MAX_INITIAL_LINKS} URLs may be provided.`);
            initialLinks.push(link);
          }
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

    // A links-only invocation is a dead path: cmdResearch feeds the (empty) query
    // through validateAndSanitizeQuery, which rejects it anyway — but with a
    // confusing "empty query" error at exit 64. Reject it up front with one
    // clear message instead: --initial-links SEEDS a query, it cannot replace one.
    if (positional.length === 0) {
      throw new UsageError(
        initialLinks.length > 0
          ? 'research requires a query; --initial-links seeds URLs for a query but cannot replace it.'
          : 'research requires a query.',
      );
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

// Flush stdout+stderr before exiting so buffered output (e.g. --json into a pipe) is not
// truncated. Uses process.exit() (not exitCode) so native handles (WASM threads, LanceDB)
// don't keep the loop alive after work is done. Module-scoped so BOTH the entry-point and
// the signal handler drain the same way — the signal path previously called process.exit()
// directly and could truncate output on Ctrl-C mid-write.
const flushAndExit = (code: number): void => {
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      process.exit(code);
    });
  });
};

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
    // and the finally blocks in each command handler also call it. Drain via
    // flushAndExit (not a bare process.exit) so buffered stdout isn't truncated.
    void safeShutdown().finally(() => flushAndExit(EXIT.SOFTWARE));
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
    // Self-heal cross-harness skill installs on every engine-touching CLI run. The
    // CLI — not the interactive pi extension — is the surface that skill invocations
    // from Claude Code / Codex / OpenClaw actually drive, so without this an update
    // that relocates the package leaves a sibling skill symlink dangling until the
    // user happens to open an interactive pi session. Best-effort and idempotent;
    // it early-returns when no skills are installed and a filesystem hiccup here must
    // never block the command. Mirrors the reconcile in the extension's activation.
    try {
      const { reconcileSkillInstalls } = await import('./skill-install/skill-installer.ts');
      reconcileSkillInstalls();
    } catch { /* best-effort self-heal; never block the CLI */ }
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
    case 'knowledge-config':
      return cmdKnowledgeConfig(parsed.knowledgeConfig!);
    case 'skill':
      return cmdSkill(parsed.skill!);
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
    if (!process.argv[1]) return false;
    // realpath BOTH sides: when installed via an npm `bin` symlink (the primary global-install
    // path), argv[1] is the symlink while import.meta.url is realpath-resolved by Node. A plain
    // path.resolve does not follow symlinks, so the two never matched and main() was silently
    // skipped — the CLI exited 0 with empty output. Resolving symlinks on both sides fixes it.
    const modulePath = fs.realpathSync(path.resolve(fileURLToPath(import.meta.url)));
    const invokedPath = fs.realpathSync(path.resolve(process.argv[1]));
    return modulePath === invokedPath;
  } catch {
    return false;
  }
})();

if (_isMain) {
  // Top-level entry. Never let an unhandled rejection escape — print a clean error.
  // flushAndExit (module-scoped above) drains both streams before process.exit() so
  // buffered output isn't truncated and native handles don't keep the loop alive.
  main(process.argv)
    .then(flushAndExit)
    .catch((err) => {
      toStderr(`\nError: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      flushAndExit(EXIT.SOFTWARE);
    });
}
