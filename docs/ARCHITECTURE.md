## Architecture

pi-research is a pi TUI extension for multi-agent web research. It runs inside the pi
process, registers its tools and commands, and manages its own browser worker pool,
service registry, and local knowledge store. One engine backs every front-end: besides
the pi extension it is exposed as a standalone CLI, a portable agent skill — the same
skill any skills-aware host runs, including OpenClaw — and a programmatic SDK
(`src/sdk.ts`).

```
pi CLI
└── pi-research extension (src/index.ts)
    ├── Registered Tools   research, health, research_knowledge_search (when the store is enabled)
    ├── Commands           /research, /research-config, /knowledge-store
    ├── Events             input (mid-run steering), session_shutdown (cleanup)
    └── Layers
        ├── Orchestration   quick/deep research coordination
        ├── Agent Tools     search, scrape, youtube_transcript, security_search, stackexchange, grep, read
        ├── Infrastructure  browser pool, knowledge store, state manager
        └── Core            service registry, scheduler, health checks
```

1. A query enters through `runResearch` — the single internal entry point — with a depth.
   Callers phrase the request in natural language: when the `research` tool is invoked
   in-session, the calling agent picks the depth (1–3) from the user's wording and the
   task's complexity, guided by the tool's usage prompt (`src/prompts/research-tool-usage.md`).
   CLI and SDK callers pass the depth explicitly.
2. Depth 0 takes the quick path; depth 1–3 takes the deep path (below). The TUI and agent
   skill are restricted to levels 1–3.
3. On the deep path the coordinator plans the research tracks and runs one initial
   search burst, then hands each researcher a set of result URLs to start from.
4. Researchers scrape and read those pages through the scrape tooling and return cited
   reports. They consider only what they scraped this session.
5. The evaluator reviews the round and either runs another round or synthesizes the
   final report.
6. The result is returned as a single cited Markdown report; the cited URLs and their
   summaries are queued into the knowledge store for future runs.

### Orchestration

`runResearch` (`IResearchOrchestration`, implemented in
`src/orchestration/research-orchestration-service.ts`) is the single internal entry
point. It dispatches on depth.

Depth 0 — quick (`QuickResearchOrchestrator`): a single researcher runs directly with
all tools; there is no coordinator, no planning phase, and no rounds. Depth 0 is
reachable only through the SDK (`runQuickResearch`) or the CLI (`--depth 0`, which the
agent skill can pass). The pi extension's `research` tool has a minimum depth of 1, so
an in-session agent can never request quick mode.

Depth 1–3 — deep (`DeepResearchOrchestrator`): the run proceeds in **rounds**. A round
is one coordinate → research → evaluate cycle — the round's agenda is planned (by the
coordinator in round 1, by the evaluator thereafter), a batch of **researchers** runs it
in parallel, and the evaluator then decides whether to run another round or synthesize.
Two limits apply independently: how many researchers run *within* a round, and how many
rounds the run may take.

| Depth | Label  | Researchers per round (max) | Rounds (max) |
|-------|--------|-----------------------------|--------------|
| 1     | normal | 2                           | 2            |
| 2     | deep   | 3                           | 3            |
| 3     | ultra  | 5                           | 3            |

These are ceilings, not targets: the coordinator and evaluator use as many researchers
and rounds as the topic needs. A depth-2 run, for example, may spawn up to 3 researchers
in each of up to 3 rounds. Queued steering messages (Alt+Enter) can unlock a few extra
rounds past the cap (`MAX_EXTRA_ROUNDS_WITH_STEERING`).

The coordinator also runs the initial search burst and distributes its result URLs to
round 1's researchers (`distributeSearchResults`), so in deep mode the researchers
themselves do not call `search`.

LLM-call conventions. Coordinator, evaluator, synthesis, JSON-repair, and
knowledge-extraction calls go through `completeSimple` + `buildSafeOptions`
(`src/core/llm/llm-utils.ts`); researcher sub-agents go through `createAgentSession`.
Two conventions apply:

- Thinking is off by default. These calls emit structured JSON or cited reports, so a
  chain-of-thought block only spends output-token budget (and can truncate the answer).
  `PI_RESEARCH_LLM_THINKING_LEVEL` (default `off`) controls it, clamped per provider.
- Output budgets are sized per role and clamped to the model's ceiling:
  `PLANNING_MAX_TOKENS` for the plan/decision, `SYNTHESIS_MAX_TOKENS` for the final
  report. A mid-round evaluation that cannot be parsed continues the existing agenda
  rather than finalizing early, so a parse failure never truncates a run.

### Research tools

Each researcher has a fixed tool set and a shared budget of 12 gathering calls per phase
(`MAX_GATHERING_CALLS`).

| Tool | Quick | Deep | Backend |
|------|-------|------|---------|
| `search` | ✓ | — | DuckDuckGo Lite via the stealth browser |
| `scrape` | ✓ | ✓ | Batch page fetch → Markdown via the stealth browser (up to 6 URLs per call) |
| `youtube_transcript` | ✓ | ✓ | YouTube captions via youtubei.js + BotGuard PoToken (≤3 videos, one call per researcher) |
| `security_search` | ✓ | ✓ | NVD, CISA KEV, GitHub Advisories, OSV |
| `stackexchange` | ✓ | ✓ | Stack Exchange network |
| `grep` | — | ✓ | Local ripgrep (from pi-coding-agent) |
| `read` | ✓ | ✓ | Local file reads (from pi-coding-agent) |

In deep research `search` is excluded — the coordinator runs the search burst and hands
out URLs directly. In quick research `grep` is excluded — the single session is not
expected to traverse a local codebase. Researchers cannot write files, run shell
commands, or reach the network outside these tools.

### Browser infrastructure

All browser work (search, scrape, health checks) goes through a poolifier
`FixedClusterPool` of worker processes — each a Node.js child process running its own
camoufox (stealth Firefox) instance. Isolating the browser in workers means a crash in
one worker cannot take down the orchestrator or other sessions.

```
BrowserTaskScheduler
└── FixedClusterPool (poolifier)
    ├── Worker 1  →  camoufox instance
    ├── Worker 2  →  camoufox instance
    └── Worker N  →  camoufox instance
```

Key files:
- `src/infrastructure/browser/browser-task-scheduler.ts` — dispatches tasks to the pool
- `src/infrastructure/browser/thread-worker.ts` — worker entry point (bundled separately by esbuild)
- `src/infrastructure/browser/thread-worker-messaging.ts` — IPC protocol
- `src/infrastructure/browser/config.ts` — pool configuration, binary path detection

During CI, workers run in `FULL_MOCK_MODE` (`PI_RESEARCH_MOCK_SEARCH` +
`PI_RESEARCH_MOCK_SCRAPE`) to avoid FixedClusterPool deadlocks in Vitest's fork context.

### Knowledge store and data handling

The knowledge store is a local LanceDB vector table of past findings. It is optional
(research works without it) and is driven entirely by the orchestrator — researchers
never call it directly:

- Before each researcher starts, the orchestrator searches the store for that
  researcher's goal and injects any matching historical URLs (with summaries) into its
  prompt as starting points.
- After a run, the cited URLs and their descriptions are enqueued into the async writer
  queue and stored in the background — writes never block a run.

On ingest, each source's summary and full scraped Markdown are split into chunks and
embedded into vectors. A SHA-256 content hash of the page dedupes re-ingested URLs:
an unchanged page is skipped, a changed page replaces its old rows. Each row carries the
vector, the normalized URL, the text and full content, a timestamp, and scope flags
(project vs. global) that are filtered at query time.

```
WriterQueue (async, non-blocking)
└── KnowledgeStore
    ├── Embedder  (onnx-community/granite-embedding-small-english-r2-ONNX via @huggingface/transformers)
    │   └── backend: auto (out-of-process WebGPU probe → webgpu or cpu) / webgpu / cpu
    └── LanceDB   (knowledge_db/ directory, Arrow-backed vector table)
```

Key files: `src/knowledge/store.ts` (LanceDB operations), `embedder.ts` (model load +
batched inference), `writer-queue.ts` (async writes + content-hash dedup), `chunker.ts`
(chunking), `webgpu-viability.ts` (out-of-process GPU probe + cached verdict),
`migration.ts` (model-change migration: drop / backup / re-embed).

The store needs native ONNX-runtime and LanceDB bindings. On platforms with no prebuilt
binary — notably Intel macOS (`darwin-x64`) — it is absent: the health check reports it
disabled-but-healthy and research runs without the cache. See
[KNOWLEDGE-STORE.md](KNOWLEDGE-STORE.md) for the full subsystem and platform matrix.

### Services and lifecycle

Services are registered with async factory functions and resolved through a registry
(`getService()`), initialized lazily or eagerly with dependencies wired at init time.

```typescript
registerService(ServiceNames.FOO, async () => {
  const dep = await getService<IBar>(ServiceNames.BAR);
  return new FooService(dep);
}, { lazyInitialization: true });

const foo = await getService<IFoo>(ServiceNames.FOO);
```

Services that hold resources implement `dispose()`; the registry disposes them in
reverse dependency order. Resolving through the registry (rather than direct imports)
enforces lifecycle discipline (init → use → dispose) and lets tests swap in mocks.

- Core (`src/core/`): `PlanningService`, `SchedulerService`
- Infrastructure (`src/infrastructure/`): `StateManagerService`, `KnowledgeStoreService`, `WriterQueue`, `MetricsService`, `HealthCheckService`, `WorkerPoolManager`, `FileLockService`, `GPUResourceService`
- Orchestration (`src/orchestration/`): `ResearchOrchestrationService`, `ResearchSessionService`, `ResearchSynthesisService`

Cross-session, cross-process state (active sessions, browser status, metrics) lives in
`StateManagerService` (`src/infrastructure/state/`), which serializes concurrent writes
with file-based locking (`FileLockService`).

### TUI

The live progress panel uses `@earendil-works/pi-tui`. Terminal state (keyboard
protocol, mouse tracking, bracketed paste) and stdio capture are handled by
`src/tui/utils/` to guarantee a clean exit.

### Project structure

```
src/
├── index.ts              extension entry point (tools, commands, events, lifecycle)
├── cli.ts                standalone CLI entry point
├── sdk.ts                programmatic SDK (non-extension use)
├── config.ts             env-var parsing, validation, singleton
├── constants.ts          team sizes, round caps, tool budgets, batch limits
├── logger.ts             structured logger (JSONL, TUI-safe)
├── tool.ts               re-export barrel for the research + health tool definitions
├── research-config.ts    /research-config TUI
├── core/
│   ├── llm/              prompts, model resolution, agentic JSON repair, inject-date
│   ├── interfaces/       abstraction contracts (observer, planning, orchestration)
│   ├── planning-service.ts, scheduler-service.ts
│   ├── service-registry.ts, service-interfaces.ts, service-initialization.ts
│   └── planning-utils.ts
├── infrastructure/
│   ├── browser/          worker pool, task scheduler, IPC, camoufox config
│   ├── state/            state manager, session tracking, metrics collector
│   ├── embedding/        local embedding server management
│   ├── knowledge-store-service.ts, metrics-service.ts, file-lock-service.ts
│   └── process-lifecycle-service.ts
├── orchestration/
│   ├── deep-research-orchestrator.ts, quick-research-orchestrator.ts
│   ├── research-orchestration-service.ts, research-synthesis-service.ts
│   ├── research-session-service.ts, session-state.ts, session-context.ts
│   ├── researcher-executor.ts, researcher.ts, headless-observer.ts
├── prompts/              Markdown prompt templates for all agents
├── tools/                search, scrape, youtube_transcript, security, stackexchange, grep, read, knowledge-search
├── knowledge/            embedder, store, writer queue, chunker, migration, webgpu probe
├── web-research/         DuckDuckGo search, scraper, retry logic
├── security/             NVD, CISA KEV, OSV, GitHub Advisory clients
├── stackexchange/        Stack Exchange API client
├── youtube/              YouTube transcript client (InnerTube + BotGuard PoToken)
├── skill-install/        research-skill installer for coding-agent harnesses
├── tui/                  panels, layout, controller, wave animation, terminal utils
├── healthcheck/          health-check registry and checks
├── cleanup/              research-result cleanup
├── observers/            research-observer implementation
├── types/                shared index and TUI types
└── utils/                circuit breaker, text utils, shared-links, metrics, error tracking
```

### Key design decisions

Sandboxed researchers — researcher agents are limited to the tool set above. They cannot
write files, spawn processes, or make arbitrary network calls.

Worker pool over direct browser — browser processes are isolated in workers so a crash
in one cannot affect the orchestrator or other sessions.

Pinned browser stack — `playwright-core` and `impit` are pinned to exact versions and
`camoufox-js` to its `0.10.x` line (`^0.10.2`, which excludes the `0.11.x` alpha); the
three are coupled and upgraded together, because each floating range broke fresh consumer
installs that our lockfile masked. camoufox-js `0.10.2` fetches Firefox
135/beta.24, the newest camoufox with binaries for every supported OS (later builds
dropped Windows). playwright-core `1.60.0` is the newest the FF135 Juggler protocol
accepts (1.61 rejects it and fails every launch). impit `0.13.0` avoids the
`only-allow pnpm` preinstall guard that impit 0.13.1/0.14.0 shipped, which fails
`npm install -g`; a direct-dependency pin is required because npm `overrides` do not
propagate to consumers. Will upgrade all three together when camoufox ships stable
cross-platform binaries. Rationale in full:
`src/infrastructure/browser/thread-worker-browser.ts`.

Pinned data stack — `apache-arrow` is a direct dependency at `21.1.0`, and `overrides`
forces the whole tree to that single version so LanceDB and Arrow share one Arrow instance
(mismatched Arrow copies do not interoperate — arrays built by one are rejected by the
other). This sits above `@lancedb/lancedb` 0.29's declared Arrow peer ceiling
(`>=15.0.0 <=18.1.0`); it is verified working, but the override should be re-validated
whenever `@lancedb/lancedb` is upgraded.

Transient-failure resilience — every LLM call is a potential single point of failure on a
streaming endpoint that can drop mid-response (undici surfaces this as `terminated`). The
coordinator and evaluator calls retry fast transient transport failures (socket aborts, 5xx,
429, provider overload) with bounded exponential backoff — mirroring the per-researcher retry
(`PI_RESEARCH_MAX_RETRIES`) — and, if still failing, degrade to a deterministic fallback plan
rather than aborting the run. An app-level LLM timeout is not retried (it already spent the
full budget); it degrades directly. Retry counts are internal constants, not configuration.

Registry over direct imports — services are registered and resolved through the registry
to support testing (mock replacement) and enforce init → use → dispose lifecycle.

Pure ESM — the codebase is ES Modules (`"type": "module"`). Worker bundles are built with
esbuild (`npm run build:worker`) before integration tests or publishing.

Enforced boundaries — `docs/deps.svg` is regenerated on every push (madge), and
architectural rules are enforced by dependency-cruiser
(`config/tooling/dependency-cruiser.cjs`).

### Built with

Browser & scraping

- [Camoufox](https://camoufox.com) — stealth Firefox (driven via [Playwright](https://playwright.dev)) for undetected search and scraping
- [poolifier](https://github.com/poolifier/poolifier) — the worker-process pool behind the browser workers
- [html-to-markdown](https://github.com/Goldziher/html-to-markdown) & [node-html-markdown](https://github.com/crosstype/node-html-markdown) — convert scraped HTML to Markdown
- `pdf-oxide-wasm` — PDF text extraction (Rust/WASM)

Knowledge store & embeddings

- [Transformers.js](https://github.com/huggingface/transformers.js) — local embedding inference (model execution via ONNX Runtime)
- Google [Dawn](https://dawn.googlesource.com/dawn) — the WebGPU backend, accessed through the `webgpu` Node binding
- [LanceDB](https://lancedb.com) — on-disk vector database
- [Apache Arrow](https://arrow.apache.org) — the columnar schema the vector table is built on

YouTube transcripts

- [youtubei.js](https://github.com/LuanRT/YouTube.js) — YouTube internal-API client
- [BgUtils](https://github.com/LuanRT/BgUtils) — BotGuard PoToken generation
- [jsdom](https://github.com/jsdom/jsdom) — DOM environment for minting the PoToken

Host & runtime

- [pi](https://github.com/earendil-works/pi) — the host runtime, agent SDK, and TUI toolkit
- [TypeBox](https://github.com/sinclairzx81/typebox) — runtime config schema and validation

### Development

```bash
npm run test:unit         # unit tests, no browser required
npm run test:integration  # requires camoufox (Xvfb only for the opt-in virtual-display tests)
npm run type-check        # TypeScript strict mode (src)
npm run type-check:tests  # TypeScript strict mode (tests)
npm run lint              # ESLint
npm run deps:check        # architectural rule enforcement
npm run build:worker      # bundle the browser worker (required before integration tests / publish)
```
