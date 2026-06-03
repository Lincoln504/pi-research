# Architecture

## Overview

pi-research is a pi CLI extension that provides multi-agent web research. It runs inside the pi process, registers tools and commands, and manages its own browser worker pool, service registry, and local knowledge store.

```
pi CLI
└── pi-research extension (src/index.ts)
    ├── Tools         research, health
    ├── Commands      /research, /research-config
    ├── Event hooks   before_agent_start, after_provider_response
    └── Layers
        ├── Orchestration   quick/deep research coordination
        ├── Tools           search, scrape, security, stackexchange, grep
        ├── Infrastructure  browser pool, knowledge store, state manager
        └── Core            service registry, scheduler, health checks
```

---

## Layers

### Orchestration

Two orchestrators handle research sessions:

**QuickResearchOrchestrator** (`src/orchestration/quick-research-orchestrator.ts`)
- Single researcher agent, depth 0
- No planning phase — agent runs directly with all tools

**DeepResearchOrchestrator** (`src/orchestration/deep-research-orchestrator.ts`)
- Coordinator → N parallel researchers → evaluator → synthesis
- Depths 1–3 map to 2/3/5 researchers and 2/3/5 rounds
- Coordinator plans research tracks; evaluator decides whether to go deeper

`runResearch` in `src/orchestration/research-manager.ts` selects the orchestrator based on depth and is the single internal entry point.

---

### Research Tools

Each researcher agent has access to a fixed tool set with shared budget (4 calls across gathering tools per phase):

| Tool | Source | Budget |
|------|--------|--------|
| `search` | DuckDuckGo Lite via stealth browser | shared |
| `scrape` | URL batch scraping via stealth browser | configurable batches |
| `security_search` | NVD, CISA KEV, GitHub Advisories, OSV | shared |
| `stackexchange` | Stack Exchange network | shared |
| `grep` | Local ripgrep | shared |
| `links` | Shared discovered-links pool (list/search) | shared |
| `stored_search` | Local knowledge store — past research sessions | shared |
| `read` | Local file reads (from pi-coding-agent) | shared |

Researchers cannot write files, run shell commands, or access the network outside these tools.

---

### Browser Infrastructure

All browser operations (search, scrape, health checks) go through a poolifier `FixedClusterPool` of worker processes. Workers are Node.js child processes each running a camoufox (stealth Firefox) instance.

```
BrowserTaskScheduler
└── FixedClusterPool (poolifier)
    ├── Worker 1  →  camoufox instance
    ├── Worker 2  →  camoufox instance
    └── Worker N  →  camoufox instance
```

Key files:
- `src/infrastructure/browser/browser-task-scheduler.ts` — dispatches tasks to pool
- `src/infrastructure/browser/thread-worker.ts` — worker entry point (bundled separately)
- `src/infrastructure/browser/thread-worker-messaging.ts` — IPC protocol
- `src/infrastructure/browser/config.ts` — pool configuration, binary path detection

Workers run in `FULL_MOCK_MODE` (both `PI_RESEARCH_MOCK_SEARCH` and `PI_RESEARCH_MOCK_SCRAPE` set) during CI to avoid FixedClusterPool deadlocks in Vitest's fork context.

---

### Knowledge Store

Scraped content is embedded and stored in LanceDB for deduplication and RAG retrieval across sessions.

```
WriterQueue (async, non-blocking)
└── KnowledgeStore
    ├── Embedder  (Xenova/all-MiniLM-L6-v2 via @huggingface/transformers)
    │   └── inference backend: webgpu (Dawn/Vulkan/Metal/D3D12) or cpu
    └── LanceDB   (knowledge_db/ directory, Arrow-backed vector table)
```

Key files:
- `src/knowledge/store.ts` — LanceDB operations
- `src/knowledge/embedder.ts` — model loading and batched inference
- `src/knowledge/writer-queue.ts` — async write queue
- `src/knowledge/migration.ts` — model change migration (drop or re-embed)

---

### Service Registry

Services are registered with async factory functions and initialized lazily or eagerly. Dependencies are resolved at initialization time via `getService()`.

```typescript
// registration
registerService(ServiceNames.FOO, async () => {
  const dep = await getService<IBar>(ServiceNames.BAR);
  return new FooService(dep);
}, { lazyInitialization: true });

// usage anywhere in the codebase
const foo = await getService<IFoo>(ServiceNames.FOO);
```

Services that hold resources implement `dispose()` for clean shutdown. The registry handles disposal in reverse dependency order.

Core services (`src/core/`): `PlanningService`, `SchedulerService`
Infrastructure services (`src/infrastructure/`): `StateManagerService`, `KnowledgeStoreService`, `WriterQueue`, `MetricsService`, `HealthCheckService`, `WorkerPoolManager`, `FileLockService`, `GPUResourceService`, and several state sub-services.

---

### State Management

Cross-session and cross-process state (active sessions, browser status, metrics) is managed by `StateManagerService` using file-based locking (`FileLockService`) to serialize concurrent writes.

---

### TUI

The research TUI uses `@earendil-works/pi-tui` to render live progress panels. Terminal state (keyboard protocol, mouse tracking, bracketed paste) is tracked and reset on all exit paths to prevent escape sequence leakage to the shell.

---

## Project Structure

```
src/
├── index.ts              extension entry point
├── config.ts             env var parsing, validation, singleton
├── logger.ts             structured logger (JSONL, TUI-safe)
├── tool.ts               tool definitions (research, health)
├── sdk.ts                programmatic SDK (non-extension use)
├── research-config.ts    /research-config TUI
├── core/
│   ├── service-registry.ts
│   ├── service-interfaces.ts
│   ├── service-initialization.ts
│   ├── planning-service.ts
│   └── scheduler-service.ts
├── infrastructure/
│   ├── browser/          worker pool, task scheduler, IPC, camoufox config
│   ├── knowledge-store-service.ts
│   ├── state-manager-service.ts
│   ├── metrics-service.ts
│   └── ...
├── orchestration/
│   ├── research-manager.ts
│   ├── deep-research-orchestrator.ts
│   ├── quick-research-orchestrator.ts
│   ├── research-orchestration-service.ts
│   └── researcher-executor.ts
├── tools/                search, scrape, security, stackexchange, grep, links
├── web-research/         DuckDuckGo search, scraper, retry logic
├── knowledge/            embedder, store, writer queue, chunker, migration
├── tui/                  TUI panels, multi-session layout
├── healthcheck/          health check registry and checks
├── cleanup/              research result cleanup
├── observers/            headless observer (SDK use)
├── security/             NVD, CISA KEV, OSV, GitHub Advisory clients
├── stackexchange/        Stack Exchange API client
└── utils/                circuit breaker, metrics, error tracking, shutdown manager
```

---

## Key Design Decisions

**No shell commands in researchers** — researcher agents are sandboxed to the tool set above. They cannot write files, spawn processes, or make arbitrary network calls.

**Worker pool over direct browser** — browser processes are isolated in workers so a crash in one worker does not affect the orchestrator or other sessions.

**Service registry over direct imports** — services are registered and resolved through the registry to support testing (mock replacement) and to enforce lifecycle discipline (init → use → dispose).

**Pure ESM** — the entire codebase uses ES Modules (`"type": "module"`). Worker bundles are built with esbuild (`npm run build:worker`) before integration tests or publishing.

**Dependency graph** — `docs/deps.svg` is regenerated automatically on every push via CI (madge). Architectural rules are enforced by dependency-cruiser (`config/.dependency-cruiser.cjs`).
