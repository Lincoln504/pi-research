# SDK & Configuration Reference

## Environment Variables

All variables are optional — defaults apply if unset. Set them in `src/.env` (relative to the extension install directory) or pass them in your shell environment.

### Research

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_TIMEOUT_MS` | `600000` | 180000–1800000 | Per-researcher timeout (3–30 min) |
| `PI_RESEARCH_MAX_RESEARCHERS` | `3` | 1–5 | Parallel researchers |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` | `1` | 1–3 | Default depth for `/research` command |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES` | `2` | 0–99 | Scrape batches per researcher (0 = unlimited) |
| `PI_RESEARCH_MAX_CONCURRENT_SCRAPES` | `3` | 1–20 | Concurrent URLs per batch |
| `PI_RESEARCH_WORKER_THREADS` | `4` | 1–16 | Browser worker processes |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `1` | 1–10 | Tasks per worker process |
| `PI_RESEARCH_MODEL` | _(session model)_ | — | Model override for researcher sub-agents |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | 5000–120000 | Per-page scrape timeout |
| `PI_RESEARCH_MAX_RETRIES` | `3` | 0–10 | Retries per researcher request |

### Knowledge Store

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_KNOWLEDGE_ENABLED` | `true` | — | Enable local vector knowledge store |
| `PI_RESEARCH_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | — | Embedding model |
| `PI_RESEARCH_EMBEDDING_DEVICE` | `webgpu` | webgpu, cpu | Inference backend |
| `PI_RESEARCH_CACHE_TTL_DAYS` | `30` | 1–365 | How long to keep cached scrapes |
| `PI_RESEARCH_MIGRATION_STRATEGY` | `drop` | drop, re-embed | What to do when embedding model changes |

### API Keys & Proxy

| Variable | Description |
|----------|-------------|
| `SEARXNG_URL` | External SearXNG instance URL — skips Docker management entirely |
| `PROXY_URL` | Proxy for outgoing requests (`socks5://`, `http://`, with optional user:pass) |
| `BRAVE_SEARCH_API_KEY` | Brave Search paid API key |
| `STACKEXCHANGE_API_KEY` | Stack Exchange API key — raises rate limits |

### Diagnostics

| Variable | Description |
|----------|-------------|
| `PI_RESEARCH_VERBOSE` | Set to `1` to write JSONL diagnostic logs to OS temp dir |
| `PI_RESEARCH_LOG_PATH` | Override path for the verbose diagnostic log file |

---

## Configuration TUI

Run `/research-config` inside pi to edit any setting interactively. The TUI reads and writes `src/.env` in the extension directory.

---

## Programmatic SDK

`src/sdk.ts` provides a standalone API for use outside the pi CLI — scripts, CI, custom tooling. It initializes the service registry and manages lifecycle internally.

```typescript
import { ResearchSDK } from '@lincoln504/pi-research/sdk';
import type { SDKOptions } from '@lincoln504/pi-research/sdk';

const sdk = new ResearchSDK({
  model,           // Model<any> from @earendil-works/pi-ai
  apiKey,          // optional: API key if not in env
  cwd,             // optional: working directory (default: process.cwd())
  config,          // optional: Partial<Config> overrides
  verbose,         // optional: enable console logging
} satisfies SDKOptions);

await sdk.initialize();

const result = await sdk.research({
  query: 'solid-state battery technology',
  depth: 2,        // 0=quick, 1=normal, 2=deep, 3=ultra
});

console.log(result.output);    // synthesized markdown
console.log(result.tokens);    // total tokens used

await sdk.shutdown();
```

The SDK handles service registration, embedder init, browser pool startup, and clean shutdown. Calling `shutdown()` is important — it drains the writer queue, closes LanceDB, and terminates workers.

---

## Extension API (internal)

`runResearch` is the internal entry point used by pi extension tools. It requires a pi `ExtensionContext` and is not intended for external callers — use the SDK above instead.

```typescript
// extension tool handler context only
import { runResearch } from '@lincoln504/pi-research';
import { createResearchRunId } from '@lincoln504/pi-research/logger';

const output: string = await runResearch({
  ctx,                    // ExtensionContext — provided by pi runtime
  query,
  depth,                  // 0 | 1 | 2 | 3
  sessionId,              // ctx.sessionId
  researchId: createResearchRunId(),
  model,                  // optional: override ctx.model
  observer,               // optional: ResearchObserver
  config,                 // optional: Config override
  excludeTools,           // optional: string[] of tool names to skip
}, abortSignal);
```

---

## Health Check API

The `health` tool (registered in pi) runs all registered health checks and returns a structured status report. Checks cover: browser pool, knowledge store, embedding model, network connectivity, and environment configuration.

Individual checks can be queried via the service registry:

```typescript
import { getService } from '@lincoln504/pi-research';
import { ServiceNames } from '@lincoln504/pi-research/core/service-interfaces';

const hc = await getService(ServiceNames.HEALTH_CHECK_CACHE);
const result = await hc.getHealth();
// result: { status: 'ok' | 'degraded' | 'error', checks: [...] }
```

---

## Knowledge Store API

The knowledge store is accessible via the service registry for custom read/write operations:

```typescript
import { getService } from '@lincoln504/pi-research';
import { ServiceNames } from '@lincoln504/pi-research/core/service-interfaces';

const ks = await getService(ServiceNames.KNOWLEDGE_STORE);

// search
const results = await ks.search('WebAssembly performance', { limit: 10 });

// write (prefer using WriterQueue for non-blocking writes)
const wq = await getService(ServiceNames.WRITER_QUEUE);
await wq.enqueue({ url, text, metadata });
```

Vector dimension is 384 (all-MiniLM-L6-v2). Stored fields: `text`, `vector`, `url`, `metadata`, `createdAt`.
