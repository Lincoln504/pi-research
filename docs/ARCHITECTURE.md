## Architecture

pi-research is a pi TUI extension for multi-agent web research. It runs inside the pi
process, registers its tools and commands, and manages its own browser worker pool,
service registry, and local knowledge store. One engine backs every front-end: besides
the pi extension it is exposed as a standalone CLI, a portable agent skill (the same
skill any skills-aware host runs) and a programmatic SDK
(`src/sdk.ts`).

```
pi CLI
└── pi-research extension (src/index.ts)
    ├── Registered Tools   research, health, research_knowledge_search (always registered; reports why when the store is disabled)
    ├── Commands           /research, /research-config, /knowledge-store
    ├── Events             input (mid-run steering), session_shutdown (cleanup), session_before_compact / session_compact, before_agent_start, after_provider_response
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
2. Depth 0 takes the quick path; depth 1–3 takes the deep path (below). The pi extension's
   tool and the TUI are restricted to levels 1–3; the CLI, SDK, and agent skill can pass 0.
3. On the deep path the coordinator plans the research tracks and runs one initial
   search burst, then hands each researcher a set of result URLs to start from.
4. Researchers scrape and read those pages through the scrape tooling and return cited
   reports. They consider only what they scraped this session.
5. The research lead's **router** reviews the round and either runs another round or ends
   the loop; its **synthesizer** then writes the final report from every report collected.
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
is one coordinate → research → route cycle — the round's agenda is planned (by the
coordinator in round 1, by the research lead's **router** thereafter), a batch of
**researchers** runs it in parallel, and the router then decides whether to run another
round or end the loop. Two limits apply independently: how many researchers run *within*
a round, and how many rounds the run may take.

The research lead is two roles, not one call doing both jobs. The router only decides; it
reads each report in full on the one round it arrives and only that report's short
coverage digest thereafter, so its input grows with team size rather than with the square
of the round count. The **synthesizer** runs exactly once, at the end, reads every report
in full, and writes the report — under a corpus budget derived from the model's context
window, reducing in partial passes and merging when the corpus does not fit. The two
prompts are `src/prompts/system-lead-router.md` and `system-lead-synthesizer.md`.

| Depth | Label  | Researchers per round (max) | Rounds (max) |
|-------|--------|-----------------------------|--------------|
| 1     | normal | 2                           | 2            |
| 2     | deep   | 3                           | 3            |
| 3     | ultra  | 5                           | 3            |

These are ceilings, not targets: the coordinator and router use as many researchers
and rounds as the topic needs. A depth-2 run, for example, may spawn up to 3 researchers
in each of up to 3 rounds. Queued steering messages (Alt+Enter) can unlock a few extra
rounds past the cap (`MAX_EXTRA_ROUNDS_WITH_STEERING`).

The coordinator also runs the initial search burst and distributes its result URLs to
round 1's researchers (`distributeSearchResults`), so in deep mode the researchers
themselves do not call `search`.

LLM-call conventions. Coordinator, router, synthesizer, JSON-repair, and
knowledge-extraction calls go through `completeSimple` (`src/core/llm/pi-ai-completion.ts`)
with `buildSafeOptions` (`src/core/llm/llm-utils.ts`); researcher sub-agents go through
`createAgentSession`.
Two conventions apply:

- Thinking is off by default. These calls emit structured JSON or cited reports, so a
  chain-of-thought block only spends output-token budget (and can truncate the answer).
  `PI_RESEARCH_LLM_THINKING_LEVEL` (default `off`) controls it, clamped per provider.
- Output budgets are sized per role and clamped to the model's ceiling:
  `PLANNING_MAX_TOKENS` for the plan/decision, `SYNTHESIS_MAX_TOKENS` for the final
  report. A mid-round evaluation that cannot be parsed continues the existing agenda
  rather than finalizing early, so a parse failure never truncates a run.

### Tool inventory

This is the canonical list of every tool the system exposes, on both surfaces.

**Host-facing tools** — registered with the pi session (`src/index.ts`) for the calling
agent to invoke:

| Tool | Purpose |
|------|---------|
| `research` | Run a full multi-source research session and return the cited Markdown report |
| `research_knowledge_search` | Instant local search of the knowledge store — checked before live research; always registered, reports why when the store is disabled |
| `health` | Verify system status (browser pool, knowledge store, GPU lock); optional liveness probe |

**Researcher-agent tools** — the fixed set each researcher sub-agent works with
(`src/tools/index.ts`). `search`, `security_search`, `stackexchange`, and
`youtube_transcript` share a budget of 12 gathering calls per phase
(`MAX_GATHERING_CALLS`); `scrape` and local `grep` have their own budgets:

| Tool | Quick | Deep | Backend |
|------|-------|------|---------|
| `search` | ✓ | — | DuckDuckGo Lite via the stealth browser |
| `scrape` | ✓ | ✓ | Batch page fetch → Markdown via the stealth browser (up to 6 URLs per call) |
| `youtube_transcript` | ✓ | ✓ | YouTube captions via youtubei.js + BotGuard PoToken (≤3 videos by default, configurable 1–5; one call per researcher) |
| `security_search` | ✓ | ✓ | NVD, CISA KEV, GitHub Advisories, OSV |
| `stackexchange` | ✓ | ✓ | Stack Exchange network |
| `grep` | — | — | Local ripgrep (from pi-coding-agent) — always excluded, see below |
| `read` | ✓ | ✓ | Local file reads (from pi-coding-agent) |

In deep research `search` is excluded — the coordinator runs the search burst and hands
out URLs directly.

`grep` is excluded at **every** depth and on every front-end (CLI, SDK, agent skill,
pi extension): this is web research, and a capable model otherwise spends turns
searching the local filesystem. Both exclusion surfaces — the `excludeTools` list
(`--exclude-tools` on the CLI, the `excludeTools` tool parameter in the extension) and
`PI_RESEARCH_DISABLED_TOOLS` — are strictly additive on top of that default: they can
only ever remove capabilities (see [CONFIGURATION.md](CONFIGURATION.md)). Before 1.3.10
a non-empty `excludeTools` list replaced the default, so naming any other tool silently
re-enabled `grep`.

Researchers cannot write files, run shell commands, or reach the network outside these
tools.

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
`migration.ts` (migration strategy types — the drop / backup / re-embed logic
itself lives in `store.ts`).

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
- Infrastructure (`src/infrastructure/`): `StateManagerService`, `KnowledgeStoreService`, `MetricsService`, `WorkerPoolManager`, `FileLockService`, `GPUResourceService` (plus `WriterQueue`, defined in `src/knowledge/` and registered here)
- Orchestration (`src/orchestration/`): `ResearchOrchestrationService`, `ResearchSessionService`, `ResearchSynthesisService`

Cross-session, cross-process state (active sessions, browser status, metrics) lives in
`StateManagerService` (`src/infrastructure/state/`), which serializes concurrent writes
with file-based locking (`FileLockService`).

### Concurrent runs (the run cap)

Every pi-research process on a machine — CLI, agent skill, pi extension, SDK — shares
one leader-elected browser pool and one embedding model. Letting an unbounded number of
research runs onto that shared pool does not slow runs down gracefully; it saturates the
priority queue and degrades *all* of them at once.

`ResearchRunSemaphore` (`src/infrastructure/research-run-semaphore.ts`) therefore gates
every `runResearch()` entry on one of N slots, realized as N well-known lock files in the
state directory and coordinated by the same `FileLockService`. Because slot ownership is
recorded as PID + process start time, a slot held by a crashed run is reclaimed
immediately by the next acquire, while a *live* holder is never stolen — a legitimate run
holds its slot for minutes, and stealing it would admit the (N+1)th run the cap exists to
prevent.

Runs beyond the cap **queue** rather than fail: the acquire polls until a slot frees,
announcing itself once through the observer (`onRunQueued`, surfaced by the CLI as
`• queued: …`) so a waiting run is never mistaken for a hung one. Only if nothing frees
within the whole queue window does it raise `ResearchRunCapacityError` — a temporary
condition the CLI reports as exit code `75`, distinct from a crash. The cap fails *open*
on any internal or IO error, so a fault in the semaphore itself can never prevent research
from running. Both the cap and the queue window are configurable
(`PI_RESEARCH_MAX_CONCURRENT_RUNS`, `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS`).

### TUI

The live progress panel uses `@earendil-works/pi-tui`, which handles terminal state
(keyboard protocol, mouse tracking, bracketed paste). stdio capture (to keep stray
output from corrupting the panel and to guarantee a clean exit) lives in
`src/utils/stdio-capture.ts`.

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

Read-only researchers — researcher agents are limited to the tool set above. They cannot
write files, spawn processes, or make arbitrary network calls. They *can* read files:
`read` is registered and the researcher exclusion list (`bash`, `write`, `edit`, `repl`,
`git`, `terminal`) does not cover it. Local `grep` is registered but always excluded (see
the tool table above). The `cwd` passed to `read` is a resolution base, not a jail — an
absolute path resolves to itself — so the boundary is "no mutation", not "only this
directory".

Worker pool over direct browser — browser processes are isolated in workers so a crash
in one cannot affect the orchestrator or other sessions.

Pinned browser stack — `playwright-core` and `impit` are pinned to exact versions and
`camoufox-js` is pinned to its `0.12.0` line; the three are coupled and upgraded together,
because each floating range broke fresh consumer installs that our lockfile masked.
playwright-core stays at `1.60.0` (1.61+ rejects camoufox's Juggler and fails every
launch — corroborated upstream: camoufox-js `0.12.0` declares
`peerDependencies: { "playwright-core": "<1.61.0" }`, the same bound this pin holds by
hand). `impit` is exact at `0.14.4` (refreshed from `0.13.0` on 2026-08-30 together with
the camoufox bump) — exact because npm `overrides` do not propagate to consumers, so an
exact pin is the only way to force a version downstream; impit's `only-allow pnpm`
preinstall-guard incident (0.13.1/0.14.0, dropped in 0.14.1) is why floating ranges are
not trusted here. Rationale in full: `src/infrastructure/browser/thread-worker-browser.ts`.

The 0.10.x→0.12.0 camoufox bump had been held back through two refresh cycles by three
blockers, all since resolved: camoufox restored Windows binaries in `v152.0.4-beta.26`
(2026-07-16); impit's pnpm guard existed only in 0.13.1/0.14.0; and camoufox-js 0.12's
better-sqlite3 13 upgrade, which initially looked like it demanded a C++ toolchain on
every install. Measured on 13.0.3: `prebuilds/` for all eight platform/arch pairs ship
INSIDE its tarball and load at runtime via node-gyp-build — no install script, nothing
for a consumer to approve. What actually broke was tooling, not the binding: npm ≤11's
injected `node-gyp rebuild` needlessly recompiles a binding.gyp with no install script
(and its node-gyp 11.2 cannot detect the VS2026 CI runner image), which is why CI runs
npm 12. Any future bump checks better-sqlite3 first, not camoufox.

The browser BINARY, by contrast, is not pinned and cannot be. `camoufox-js fetch` takes
no version argument: it walks the `daijro/camoufox` GitHub releases newest-first and takes
the first non-prerelease release carrying an asset for this OS/arch. So the binary a
consumer gets is whatever camoufox published most recently at install time, regardless of
which camoufox-js version is installed — the npm pins do not freeze it, and a future
camoufox release could break launches for fresh installs with no change on our side.
Windows assets were in fact missing from `v146-hardware` through `v152.0.2-alpha` and
returned in `v152.0.4-beta.26` (2026-07-16). Current newest is `v152.0.4-beta.28`
(Firefox 152); it launches and drives cleanly under playwright-core `1.60.0`, verified
directly, as does the older `v135.0.1-beta.24` an existing cache may still hold. The
practical consequence is that browser freshness is independent of the npm pin: a stale
`camoufox-js` does not mean a stale Firefox. Re-verify a real launch when bumping this
stack — the unit and integration suites mock the browser and cannot catch a Juggler
mismatch.

Pinned data stack — `apache-arrow` is a direct dependency at `21.1.0`, and `overrides`
forces the whole tree to that single version so LanceDB and Arrow share one Arrow instance
(mismatched Arrow copies do not interoperate — arrays built by one are rejected by the
other). This sits above `@lancedb/lancedb` 0.37's declared Arrow peer ceiling
(`>=15.0.0 <=18.1.0`) — npm will not even resolve the pairing without the override — and
it is verified working, but it should be re-validated whenever `@lancedb/lancedb` is
upgraded.

`21.1.0` is exact for a measured reason, not caution. Bumping the PATCH-looking minor to
`21.2.0` breaks the store outright: LanceDB's Rust-side Arrow reader cannot parse the
schema that Arrow 21.2 writes, failing every table open with
`Failed to read IPC file: Arrow error: Parser error: Unable to get root as footer:
RangeOutOfBounds … UnionVariant { variant: "Type::FixedSizeList" }` — 56 unit and 36
integration tests, every one that touches a real table. Do not treat this range as
caret-safe. Note also that every `@lancedb/lancedb` release through 0.37 declares the same
`<=18.1.0` Arrow ceiling, so upgrading LanceDB does not resolve the override; it only
changes which pairing needs re-validating.

Pinned validation library — `typebox` is pinned to the exact version the pi host packages
depend on (`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` pin `1.3.7` across
the 0.84.x line). Every
tool's parameter schema is built with TypeBox here and handed across the boundary to pi's
tool system, so the two must agree on `Value.Check`/`Convert` semantics. A floating `^1.1.38`
range let a fresh consumer install resolve pi-research to a newer TypeBox than pi's, shipping
an untested cross-version pairing; the exact pin keeps pi-research on the same version pi
validates with. Bump it in lockstep with the pi host, not independently. (`undici`, by
contrast, tracks the host's major — the host is on undici 8, and pi-research only uses the
stable `Agent` connector API, so it follows `^8`.)

Transient-failure resilience — every LLM call is a potential single point of failure on a
streaming endpoint that can drop mid-response (undici surfaces this as `terminated`). The
coordinator and research-lead calls retry fast transient transport failures (socket aborts, 5xx,
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
- [html-to-markdown](https://github.com/kreuzberg-dev/html-to-markdown) — converts scraped HTML to Markdown (node-html-markdown serves as the pure-JS fallback)
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
npm run type-check:native        # SAME checks on the TS7 native compiler (pinned; ~9x faster)
npm run type-check:native:tests  # TS7 native check, test project
npm run lint              # ESLint
npm run deps:check        # architectural rule enforcement
npm run build:worker      # bundle the browser worker (required before integration tests / publish)
```
