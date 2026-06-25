# Architecture

## Overview

pi-research is a pi CLI extension that provides multi-agent web research. It runs inside the pi process, registers tools and commands, and manages its own browser worker pool, service registry, and local knowledge store.

```
pi CLI
└── pi-research extension (src/index.ts)
    ├── Tools         research, health, research_knowledge_search (when store enabled)
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
- Depths 1–3 map to 2/3/5 researchers and 2/3/3 rounds
- Coordinator plans research tracks; evaluator decides whether to go deeper

`runResearch` in `IResearchOrchestration` is the single internal entry point, implemented in `src/orchestration/research-orchestration-service.ts`.

**LLM-call conventions.** The coordinator, evaluator, final synthesis, JSON-repair, and knowledge-extraction calls all go through `completeSimple` + `buildSafeOptions` (`src/core/llm/llm-utils.ts`), and the researcher sub-agents through `createAgentSession`. Two conventions apply uniformly:

- **Thinking is off by default.** These calls emit structured JSON or cited reports, not open-ended reasoning, so a chain-of-thought block only consumes the output-token budget (and can truncate the answer before any text is produced) for at most a marginal quality gain that does not justify the latency and token cost. The level is the single `PI_RESEARCH_LLM_THINKING_LEVEL` knob (default `off`), passed through pi's model-agnostic reasoning option — pi clamps it to whatever each provider supports.
- **Output budgets are sized per role**, clamped to the model's real ceiling: a generous budget for the plan/decision (`PLANNING_MAX_TOKENS`) and a larger one for the final report (`SYNTHESIS_MAX_TOKENS`). The final report *is* the evaluator's `synthesize` response, so that call carries the report budget. A mid-round evaluation that cannot be parsed continues the existing agenda rather than finalizing early, so a transient model hiccup never truncates a run.

---

### Research Tools

Each researcher agent has access to a fixed tool set with shared budget (12 calls across gathering tools per phase):

| Tool | Quick | Deep | Source |
|------|-------|------|--------|
| `search` | ✓ | — | DuckDuckGo Lite via stealth browser |
| `scrape` | ✓ | ✓ | URL batch scraping via stealth browser (up to 6 URLs each) |
| `security_search` | ✓ | ✓ | NVD, CISA KEV, GitHub Advisories, OSV |
| `stackexchange` | ✓ | ✓ | Stack Exchange network |
| `grep` | — | ✓ | Local ripgrep |
| `read` | ✓ | ✓ | Local file reads (from pi-coding-agent) |

In deep research, `search` is excluded from researchers — the orchestrator runs the search burst and distributes result URLs directly. In quick research, `grep` is excluded — the single researcher session is not expected to do local codebase traversal.

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

Scraped content is embedded and stored in LanceDB for cross-session deduplication and RAG retrieval.

**Pipeline integration** — the knowledge store is accessed at the orchestrator level, not by researcher agents directly:
- Before each researcher starts, the orchestrator queries the store per-researcher goal and injects matching historical URLs (with summaries) into the researcher's system prompt.
- After research completes, parsed citation URLs and descriptions are enqueued into the writer queue for the next session.

This keeps the knowledge store integration deterministic and pipeline-controlled rather than relying on researchers to call it explicitly.

```
WriterQueue (async, non-blocking)
└── KnowledgeStore
    ├── Embedder  (onnx-community/granite-embedding-small-english-r2-ONNX via @huggingface/transformers)
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
Infrastructure services (`src/infrastructure/`): `StateManagerService`, `KnowledgeStoreService`, `WriterQueue`, `MetricsService`, `HealthCheckService`, `WorkerPoolManager`, `FileLockService`, `GPUResourceService`.
Orchestration services (`src/orchestration/`): `ResearchOrchestrationService`, `ResearchSessionService`, `ResearchSynthesisService`.

---

### State Management

Cross-session and cross-process state (active sessions, browser status, metrics) is managed by `StateManagerService` (in `src/infrastructure/state/`) using file-based locking (`FileLockService`) to serialize concurrent writes.

---

### TUI

The research TUI uses `@earendil-works/pi-tui` to render live progress panels. Terminal state (keyboard protocol, mouse tracking, bracketed paste) and stdio capture are managed by utilities in `src/tui/utils/` to ensure a clean exit.

---

## Project Structure

```
src/
├── index.ts              extension entry point
├── config.ts             env var parsing, validation, singleton
├── logger.ts             structured logger (JSONL, TUI-safe)
├── tool.ts               tool definitions (research, health)
├── sdk.ts                programmatic SDK (non-extension use)
├── openclaw-entry.ts     OpenClaw plugin entry point
├── research-config.ts    /research-config TUI
├── core/
│   ├── llm/              agentic repair, prompts, model resolution, inject-date
│   ├── interfaces/       abstraction contracts (observer, planning, orchestration)
│   ├── service-registry.ts
│   ├── service-interfaces.ts
│   ├── service-initialization.ts
│   ├── planning-service.ts
│   └── scheduler-service.ts
├── infrastructure/
│   ├── browser/          worker pool, task scheduler, IPC, camoufox config
│   ├── state/            state manager, session tracking, metrics collector
│   ├── embedding/        local embedding server management
│   ├── types/            infrastructure-level types
│   ├── knowledge-store-service.ts
│   ├── metrics-service.ts
│   ├── process-lifecycle-service.ts
│   ├── file-lock-service.ts
│   └── service-initialization.ts
├── orchestration/
│   ├── session/          in-memory research session tracking, PI session metadata
│   ├── deep-research-orchestrator.ts
│   ├── quick-research-orchestrator.ts
│   ├── research-orchestration-service.ts
│   ├── researcher-executor.ts
│   ├── researcher.ts
│   └── service-initialization.ts
├── prompts/              Markdown prompt templates for all agents
├── tools/                search, scrape, security, stackexchange, grep, read, knowledge-search
├── skill-install/        research-skill installer for coding-agent harnesses
├── web-research/         DuckDuckGo search, scraper, retry logic
├── knowledge/            embedder, store, writer queue, chunker, migration
├── tui/
│   ├── utils/            terminal state, stdio capture
│   └── ...               panels, layout, controller, wave animation
├── healthcheck/          health check registry and checks
├── cleanup/              research result cleanup
├── observers/            research-observer implementation
├── security/             NVD, CISA KEV, OSV, GitHub Advisory clients
├── stackexchange/        Stack Exchange API client
├── types/                shared index types and TUI types
└── utils/                circuit breaker, text-utils, shared-links, metrics, error tracking
```

---

## Key Design Decisions

**No shell commands in researchers** — researcher agents are sandboxed to the tool set above. They cannot write files, spawn processes, or make arbitrary network calls.

**Worker pool over direct browser** — browser processes are isolated in workers so a crash in one worker does not affect the orchestrator or other sessions.

**Service registry over direct imports** — services are registered and resolved through the registry to support testing (mock replacement) and to enforce lifecycle discipline (init → use → dispose).

**Pure ESM** — the entire codebase uses ES Modules (`"type": "module"`). Worker bundles are built with esbuild (`npm run build:worker`) before integration tests or publishing.

**Dependency graph** — `docs/deps.svg` is regenerated automatically on every push via CI (madge). Architectural rules are enforced by dependency-cruiser (`config/tooling/dependency-cruiser.cjs`).
