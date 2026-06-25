# SDK & Configuration Reference

The programmatic SDK, plus the complete configuration model and environment-variable
reference that every front-end shares.

- [Programmatic SDK](#programmatic-sdk)
- [Configuration model](#configuration-model)
- [Environment variables](#environment-variables)
- [Health & knowledge-store APIs](#health--knowledge-store-apis)

---

## Programmatic SDK

`src/sdk.ts` is a library for scripts, CI, and custom tooling. **It is configured
from code, not from a global overlay file** — there is no `sdk.env`. It reads the
base `~/.pi/research/config.env` as a convenience baseline, and everything is
overridable via `options.config`. Pass `ignoreGlobalConfig: true` to ignore the
global file entirely and run purely from defaults + `process.env` + `options.config`
— fully self-contained and reproducible from code.

```typescript
import {
  initResearchSDK,
  runDeepResearch,
  runQuickResearch,
  getResearchReports,
  shutdownResearchSDK,
} from '@lincoln504/pi-research';

// 1. Initialize (configured entirely in code; no global config needed)
await initResearchSDK({
  model: 'openrouter/deepseek/deepseek-v4-flash', // string "provider/id" or a Model object
  ignoreGlobalConfig: true,                       // hermetic: ignore ~/.pi/research/config.env
  config: { MAX_SCRAPE_BATCHES: 4 },              // typed Config overrides
});

// 2. Deep research (depth 1–3)
const markdown = await runDeepResearch('solid-state battery technology', { depth: 2 });

// 3. Quick research (depth 0)
const quick = await runQuickResearch('what is the capital of France');

// 4. Retrieve per-researcher reports from the last run
const reports = await getResearchReports();

// 5. Cleanup — REQUIRED: drains the writer queue, closes LanceDB, kills workers
await shutdownResearchSDK();
```

`initResearchSDK` must run before any research call. Auth resolves from
`options.apiKey` + `options.provider`, else `process.env.PI_RESEARCH_API_KEY` /
`PI_RESEARCH_PROVIDER`, else pi's `~/.pi/agent/auth.json`. Other exports include
`runResearchDetailed`, `searchKnowledge`, `scrapeUrl`, `getResearchHealth`,
`getLastRunStats`, and `getSessionMetrics`. Both `@lincoln504/pi-research` and
`@lincoln504/pi-research/sdk` export these symbols.

The SDK never writes report files (a library should not have surprising side
effects). Report export is a front-end concern — the pi extension, OpenClaw
plugin, and CLI do it when `PI_RESEARCH_REPORT_EXPORT_ENABLED=true`.

### Init options

| Option | Description |
|--------|-------------|
| `model` | `"provider/id"` string or a `Model` object. Omit to use the first available pi model. |
| `apiKey` / `provider` | Explicit credentials (provider required with apiKey). |
| `config` | `Partial<Config>` overrides, applied over the base/defaults. |
| `ignoreGlobalConfig` | Skip `config.env` entirely — defaults + `process.env` + `config` only. |
| `cwd` | Working directory for logs and the knowledge store. |
| `verbose` | Mirror logs to the console. |

---

## Configuration model

Configuration is layered. From lowest to highest precedence (**later wins**):

```
built-in defaults
  < ~/.pi/research/config.env                 (base, shared; edited by /research-config)
  < ~/.pi/research/{pi,openclaw,cli}.env       (optional per-front-end overlay)
  < legacy .pi-research.env (deprecated; auto-migrated to the registry)
  < project registry (~/.pi/state/project-settings.json, per-directory)
  < process.env                                (real shell env always wins)
```

**Per-front-end overlays** let each front-end be configured independently over the
shared base. Exactly three overlay interfaces exist — `pi.env`, `openclaw.env`,
`cli.env` — one per front-end. There is intentionally **no `sdk.env`**: the SDK is
a library configured from code (above). The overlay files do not exist by default;
create the one you need by hand. `/research-config` edits only the base
`config.env` (editing the merged view would bake overlay values into the base).

Example — give the standalone CLI / agent skill its own model without touching the
pi extension or OpenClaw:

```sh
# ~/.pi/research/config.env   (shared baseline)
PI_RESEARCH_KNOWLEDGE_STORE_MODE=project

# ~/.pi/research/cli.env       (standalone CLI / agent skill only)
PI_RESEARCH_MODEL=openrouter/anthropic/claude-sonnet-4-6
PI_RESEARCH_DEFAULT_RESEARCH_DEPTH=2
```

For a one-off override, just export the variable for that process — `process.env`
beats every file.

---

## Environment variables

The repo's `.env.example` is the canonical, exhaustive list with ranges
and defaults. The most-used variables:

### Research

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_TIMEOUT_MS` | `300000` | 180000–1800000 | Per-researcher timeout (3–30 min) |
| `PI_RESEARCH_MAX_RESEARCHERS` | `3` | 1–5 | Parallel researchers |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` ¹ | `1` | 1–3 | Depth for `/research` and CLI when `--depth` is omitted |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES` | `2` | 0–99 | Scrape batches per researcher (0 = unlimited) |
| `PI_RESEARCH_MAX_CONCURRENT_SCRAPES` | `3` | 1–20 | Concurrent URLs per batch |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS` | `3` | 1–5 | Videos transcribed per `youtube_transcript` call |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_TIMEOUT_MS` | `20000` | 5000–120000 | Per-video transcript timeout |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG` | `en` | — | Preferred caption language (BCP-47 prefix) |
| `PI_RESEARCH_YOUTUBE_QUERY_EVERY_N` | `5` | 1–100 | Append `youtube` to ~one-in-N search queries (1 = every query) |
| `PI_RESEARCH_YOUTUBE_POTOKEN_REQUEST_KEY` | _(built-in)_ | — | Advanced: override the BotGuard PoToken web request key |
| `PI_RESEARCH_WORKER_THREADS` | `4` | 1–10 | Browser worker processes |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `2` | 1–10 | Tasks per worker process |
| `PI_RESEARCH_MODEL` | _(session model)_ | — | Model override for research sub-agents |
| `PI_RESEARCH_MAX_RETRIES` | `2` | 0–5 | Retries per researcher request |
| `PI_RESEARCH_RETRY_DELAY_MS` | `2000` | 100–10000 | Base delay between retries (ms) |
| `PI_RESEARCH_REPORT_EXPORT_ENABLED` | `false` | — | Front-ends write a Markdown report file and surface its path |

### Timeouts

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_TIMEOUT_MS` | `300000` | 60000–600000 | Coordinator/evaluator/repair LLM call timeout |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | 5000–120000 | Per-page scrape timeout |
| `PI_RESEARCH_SEARCH_TIMEOUT_MS` | `45000` | 5000–120000 | Browser search page timeout |
| `PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS` | `10000` | 2000–120000 | Queue-wait margin added to each op's own timeout (search = SEARCH_TIMEOUT_MS + this; scrape = SCRAPE_TIMEOUT_MS + this) |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `10000` | 2000–120000 | Health-check timeout |

### LLM output & reasoning

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_THINKING_LEVEL` | `off` | off · minimal · low · medium · high | Chain-of-thought level for all engine LLM work (coordinator, evaluator, synthesis, repair, knowledge, and researcher sub-agents). Off by default — these calls emit structured JSON / cited reports, so thinking only consumes the output budget. Clamped per model by pi. |
| `PI_RESEARCH_PLANNING_MAX_TOKENS` | `16384` | 1024–131072 | Max output tokens for the plan + mid-round evaluator decision (clamped to the model ceiling) |
| `PI_RESEARCH_SYNTHESIS_MAX_TOKENS` | `32768` | 1024–131072 | Max output tokens for the final synthesized report (clamped to the model ceiling) |

### Knowledge store

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_KNOWLEDGE_STORE_MODE` ¹ | `global` | none, project, global | Knowledge store mode |
| `PI_RESEARCH_EMBEDDING_MODEL` | `onnx-community/granite-embedding-small-english-r2-ONNX` | — | Embedding model |
| `PI_RESEARCH_EMBEDDING_DEVICE` | `webgpu` | webgpu, cpu | Inference backend |
| `PI_RESEARCH_CACHE_TTL_DAYS` | `30` | 1–365 | How long to keep cached scrapes |
| `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` | drop, backup, re-embed | What to do when the embedding model changes |
| `PI_RESEARCH_KNOWLEDGE_DIR` | _(auto)_ | — | Override the knowledge-store database directory |
| `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` | 10000–600000 | Embedding-model init timeout |

> ¹ Project-scoped: saved per-directory in `~/.pi/state/project-settings.json` via
> `/research-config`. All other variables are user-scoped (base `config.env` or a
> front-end overlay).

### API keys (all optional)

| Variable | Description |
|----------|-------------|
| `PI_RESEARCH_API_KEY` / `PI_RESEARCH_PROVIDER` | Explicit LLM credentials for SDK / CLI / OpenClaw mode (not needed when using pi's own auth). |
| `STACKEXCHANGE_API_KEY` | Raises the Stack Exchange tool's limit from 300/day to 10,000/day. |
| `GITHUB_TOKEN` | Raises the security tool's GitHub Advisory limit from 60/hr to 5000/hr (any default-scope token). |
| `NVD_API_KEY` | Raises the security tool's NVD limit ~10× (and tightens request spacing). |

### Advanced & diagnostics

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_TMP_DIR` | `~/.cache/pi-research/profiles` | Transient browser-profile dir. Defaults to disk; point under the system temp dir to use tmpfs/RAM. |
| `PI_RESEARCH_USE_XVFB` | _(unset)_ | Linux only. Bare-TTY runs are true-headless and need no Xvfb; set `true` to opt into a virtual framebuffer (`sudo apt install xvfb`). |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `100` | TUI refresh debounce (0–1000 ms). |
| `PI_RESEARCH_DEBUG` | `false` | Verbose diagnostic logging to the OS temp dir. |
| `PI_RESEARCH_CONSOLE_LOG` | `false` | Mirror logs to stdout/stderr (useful in CI / headless). |
| `PI_RESEARCH_LOG_PATH` | _(OS temp)_ | Override the verbose log file path (browser workers inherit it automatically). |
| `PI_RESEARCH_STATE_DIR` | `~/.pi/state` | Override the state directory. |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | _(unset)_ | Set `1`/`true` to skip the pre-flight browser/embedding health check and rely on per-task timeouts. |

---

## Health & knowledge-store APIs

The `health` tool (and the SDK's `getResearchHealth()`) runs every registered
health check — browser capability, browser runtime, knowledge store, and state
manager — and returns a structured report:

```typescript
import { initResearchSDK, getResearchHealth } from '@lincoln504/pi-research/sdk';

await initResearchSDK();                 // required first — throws if not initialized
const result = await getResearchHealth();
// { success: boolean, status: 'healthy' | 'degraded' | 'unhealthy', components: [...] }
```

The knowledge store is an internal service, not a public export. It is populated
automatically during research runs; query stored findings with the SDK's
`searchKnowledge()` or the `research_knowledge_search` tool. The vector dimension
is model-dependent (auto-detected); stored fields are `text`, `vector`, `url`,
`metadata`, `timestamp`.
