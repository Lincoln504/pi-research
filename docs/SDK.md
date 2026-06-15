# SDK & Configuration Reference

## Environment Variables

Settings are loaded with the following precedence:
1.  **Defaults**: Built-in fallback values.
2.  **Global Config**: `~/.pi/research/config.env`.
3.  **Project Registry**: `~/.pi/state/project-settings.json` (per-directory).
4.  **Shell Environment**: Variables set in your shell (e.g., `export PI_RESEARCH_TIMEOUT_MS=600000`).

### Research

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_TIMEOUT_MS` | `300000` | 180000–1800000 | Per-researcher timeout (3–30 min) |
| `PI_RESEARCH_MAX_RESEARCHERS` | `3` | 1–5 | Parallel researchers |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` ¹ | `1` | 1–3 | Default depth for `/research` command |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES` | `2` | 0–99 | Scrape batches per researcher (0 = unlimited) |
| `PI_RESEARCH_MAX_CONCURRENT_SCRAPES` | `3` | 1–20 | Concurrent URLs per batch |
| `PI_RESEARCH_WORKER_THREADS` | `4` | 1–10 | Browser worker processes |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `2` | 1–10 | Tasks per worker process |
| `PI_RESEARCH_MODEL` | _(session model)_ | — | Model override for researcher sub-agents |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | 5000–120000 | Per-page scrape timeout |
| `PI_RESEARCH_MAX_RETRIES` | `2` | 0–5 | Retries per researcher request |
| `PI_RESEARCH_RETRY_DELAY_MS` | `2000` | 100–10000 | Base delay between retries (ms) |
| `PI_RESEARCH_REPORT_EXPORT_ENABLED` | `false` | — | Auto-export a markdown report on completion |

### Timeouts

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_TIMEOUT_MS` | `300000` | 60000–600000 | Coordinator/evaluator LLM call timeout |
| `PI_RESEARCH_SEARCH_TIMEOUT_MS` | `45000` | 5000–120000 | Browser search page timeout |
| `PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS` | `10000` | 2000–120000 | Individual browser task timeout |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `10000` | 2000–120000 | Health check timeout |

### Knowledge Store

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_KNOWLEDGE_STORE_MODE` ¹ | `none` | — | Knowledge store mode: 'none', 'project', or 'global' |
| `PI_RESEARCH_EMBEDDING_MODEL` | `onnx-community/granite-embedding-small-english-r2-ONNX` | — | Embedding model |
| `PI_RESEARCH_EMBEDDING_DEVICE` | `webgpu` | webgpu, cpu | Inference backend |
| `PI_RESEARCH_CACHE_TTL_DAYS` | `30` | 1–365 | How long to keep cached scrapes |
| `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` | drop, backup, re-embed | What to do when embedding model changes |
| `PI_RESEARCH_KNOWLEDGE_DIR` | _(auto)_ | — | Override the knowledge store database directory |
| `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` | 10000–600000 | Embedding model init timeout |

> ¹ Project-scoped: saved per-directory in `~/.pi/state/project-settings.json` via `/research-config`.
> All other variables are user-scoped: saved to `~/.pi/research/config.env`.

### Advanced

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `100` | 0–1000 | TUI refresh debounce interval |
| `PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING` | `0.15` | 0.05–1.0 | Max context fraction for initial scrape |
| `PI_RESEARCH_AVG_TOKENS_PER_SCRAPE` | `2500` | 500–10000 | Estimated tokens per scrape (for planning) |
| `PI_RESEARCH_USE_XVFB` | _(unset)_ | `true` | Linux only. On a bare TTY (no DISPLAY/Wayland) the browser runs true-headless and needs no Xvfb. Set `true` to opt into Xvfb (`headless:'virtual'`) for a real virtual framebuffer — requires `sudo apt install xvfb`. |

### API Keys

| Variable | Description |
|----------|-------------|
| `STACKEXCHANGE_API_KEY` | Stack Exchange API key — raises rate limits from 300/day to 10,000/day |

### Diagnostics

| Variable | Description |
|----------|-------------|
| `PI_RESEARCH_DEBUG` | Set to `true` to enable verbose diagnostic logs to OS temp dir |
| `PI_RESEARCH_CONSOLE_LOG` | Set to `true` to mirror logs to stdout/stderr |
| `PI_RESEARCH_LOG_PATH` | Override path for the verbose diagnostic log file |
| `PI_RESEARCH_STATE_DIR` | Override the state directory (default: `~/.pi/state`) |

---

## Configuration TUI

Run `/research-config` inside pi to manage settings. The TUI handles two levels of configuration:

1.  **Global Settings**: Stored in `~/.pi/research/config.env`. These apply across all your projects.
2.  **Project Settings**: Stored in the Centralized Registry (`~/.pi/state/project-settings.json`). These are scoped to your current working directory and automatically applied when you run research in that folder.

---

## Programmatic SDK

`src/sdk.ts` provides a standalone API for use outside the pi CLI — scripts, CI, custom tooling. It initializes the service registry and manages lifecycle internally.

```typescript
import { 
  initResearchSDK, 
  runDeepResearch, 
  runQuickResearch,
  getResearchReports,
  shutdownResearchSDK
} from '@lincoln504/pi-research';

// 1. Initialize
await initResearchSDK({
  model: 'openrouter/deepseek/deepseek-v4-flash', // or a Model object
  verbose: false,
  config: {
    MAX_SCRAPE_BATCHES: 4,
  }
});

// 2. Run Research
const markdown = await runDeepResearch('solid-state battery technology', {
  depth: 2, // 1-3
});

// 3. Quick research (depth 0)
const quickResult = await runQuickResearch('what is the capital of France');

// 4. Retrieve previous reports
const reports = await getResearchReports('my-research-id');

// 5. Cleanup
await shutdownResearchSDK();
```

Initialization is required before calling research methods. `shutdownResearchSDK()` is critical — it drains the writer queue, closes LanceDB, and terminates worker processes.

---

## Extension API (internal)

`runResearch` is the internal entry point used by pi extension tools. It is wired up automatically via `src/index.ts` when the extension activates — it requires a pi `ExtensionContext` and is not intended for external callers. Use the SDK instead.

---

## Health Check API

The `health` tool (registered in pi) runs all registered health checks and returns a structured status report. Checks cover: browser pool, knowledge store, embedding model, network connectivity, and environment configuration.

The same checks are available via the SDK helper:

```typescript
import { runHealthCheck } from '@lincoln504/pi-research/sdk';

const result = await runHealthCheck();
// result: { success: boolean, status: 'healthy' | 'degraded' | 'unhealthy', components: [...] }
```

---

## Knowledge Store API

The knowledge store is an internal service not exposed as a public SDK export. Access it through `runDeepResearch` / `runQuickResearch`, which populate it automatically during research runs. Use the `research_knowledge_search` pi tool to query stored findings across sessions.

Vector dimension is model-dependent (auto-detected at runtime). Stored fields: `text`, `vector`, `url`, `metadata`, `timestamp`.
