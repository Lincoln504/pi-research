# OpenClaw Integration Plan — Deep Technical Analysis

## 1. Current Architecture: Three Entry Points

pi-research has **three** conceptual entry points, each with different coupling levels:

### 1.1 Pi Extension (`src/index.ts`)
- **Entry**: `export default async function(pi: ExtensionAPI)`
- **Coupling**: DEEP — subscribes to pi events, uses pi TUI, pi shortcuts, pi commands
- **What it registers**: 2 tools (`research`, `health`), 2 commands (`/research`, `/research-config`), 1 shortcut (Alt+P), 4 event handlers (`input`, `session_shutdown`, `before_agent_start`, `after_provider_response`)
- **OpenClaw relevance**: NONE — this is purely pi-specific orchestration. Not reused.

### 1.2 Programmatic SDK (`src/sdk.ts`)
- **Entry**: `initResearchSDK()` → `runDeepResearch()` / `runQuickResearch()`
- **Coupling**: MODERATE — uses `ModelRegistry`, `AuthStorage`, `completeSimple` from pi packages, but creates its own mock context
- **What it does**: Initializes services, creates mock ExtensionContext, calls orchestrators directly
- **OpenClaw relevance**: HIGH — this is the pattern to follow. The SDK already proves that research works without the pi extension host.

### 1.3 Service Layer (shared by both above)
- **Entry**: `registerCoreServices()` + `registerInfrastructureServices()` + `initializeCoreServices(ctx)`
- **Coupling**: LOW — most services are pure logic (browser pool, search, scrape, knowledge store)
- **Critical exception**: `PlanningService` stores `ctx` to access `ctx.modelRegistry.getApiKeyAndHeaders(model)` for LLM calls
- **OpenClaw relevance**: HIGH — all services work, just need proper context shim

## 2. Depth System — How It Actually Works

### Depth → Orchestrator Routing (in `ResearchOrchestrationService.runResearch()`)

```
depth 0 → QuickResearchOrchestrator  (1 researcher, 1 round, fast)
depth 1 → DeepResearchOrchestrator   (complexity=1: 2 researchers, 2 rounds, 10 queries/researcher)
depth 2 → DeepResearchOrchestrator   (complexity=2: 3 researchers, 3 rounds, 15 queries/researcher)
depth 3 → DeepResearchOrchestrator   (complexity=3: 5 researchers, 5 rounds, 20 queries/researcher)
```

### Key Finding: Pi Extension Clamps Depth to 1-3

In `research-tool-definition.ts`:
```typescript
normalized['depth'] = Math.max(1, Math.min(3, parsed));
```

The pi extension **never exposes depth 0** to the LLM. Depth 0 is only accessible via the SDK's `runQuickResearch()`.

**For OpenClaw**: Expose depth 0-3 with default 1 (matching SDK behavior, not pi extension behavior).

### What Each Depth Actually Does

| Depth | Orchestrator | Researchers | Rounds | Max Queries/Researcher | Total Queries Cap | Typical Duration |
|-------|-------------|-------------|--------|----------------------|-------------------|-----------------|
| 0 | QuickResearch | 1 | 1 | 5-10 (single search) | ~10 | 30-60s |
| 1 | DeepResearch(1) | 2 | 2 | 10 | 20 | 2-5min |
| 2 | DeepResearch(2) | 3 | 3 | 15 | 45 | 5-10min |
| 3 | DeepResearch(3) | 5 | 5 | 20 | 100 | 10-20min |

## 3. Critical Dependency Chain

The research execution path has exactly **one hard coupling** to pi's runtime:

```
Research Tool execute()
  → ResearchOrchestrationService.runResearch()
    → DeepResearchOrchestrator.run() / QuickResearchOrchestrator.run()
      → PlanningService.generatePlan() / updatePlanForRound()
        → complete() / completeSimple() from @earendil-works/pi-ai  ← LLM call (needs API key)
        → ctx.modelRegistry.getApiKeyAndHeaders(model)              ← API key resolution
      → ResearchOrchestrationService.runResearchers()
        → runResearcher()
          → createResearcherSession()
            → createAgentSession() from @earendil-works/pi-coding-agent  ← THE HARD COUPLING
            → SessionManager.inMemory() from pi-coding-agent
            → SettingsManagerClass.inMemory() from pi-coding-agent
            → makeResourceLoader() — mocks pi's ResourceLoader
            → createResearchTools() → createReadTool() from pi-coding-agent
                                    → createGrepToolDefinition() from pi-coding-agent
```

### What `createAgentSession` Does
Creates an isolated agent session that:
1. Has its own message history (via `SessionManager.inMemory()`)
2. Has tool dispatch for custom tools
3. Has LLM streaming support
4. Has abort/timeout handling
5. Returns an `AgentSession` with `prompt()`, `subscribe()`, `abort()` methods

### Why This Is Acceptable for OpenClaw
- `createAgentSession` is a **runtime implementation detail** — OpenClaw never sees it
- The researcher agents run as isolated LLM sessions
- pi-coding-agent is already a `peerDependency` — it just needs to be installed
- The SDK already proves this works without the pi extension host

## 4. The Mock Context — What the SDK Creates

From `src/sdk.ts`, the minimum viable context is:

```typescript
{
  cwd: string,                    // Working directory for file operations
  mode: 'print',                  // Always print mode (no TUI)
  hasUI: false,                   // No UI — all UI paths are no-ops
  model: Model<any>,              // The resolved model object
  modelRegistry: ModelRegistry,   // For API key resolution in PlanningService
  getContextUsage: () => undefined,
  getSystemPrompt: () => '',
  getSignal: () => undefined,
  compact: () => {},
  abort: () => {},
  shutdown: () => {},
  getSystemPromptOptions: () => ({ selectedTools: ['research', 'health'] }),
  ui: {
    notify: () => {},
    setWidget: () => {},
    custom: async () => ({ type: 'cancel' }),
    confirm: async () => false,
    onTerminalInput: () => (() => {}),
  },
  sessionManager: {
    getSessionId: () => 'sdk-session',
    getBranch: () => [],
  },
}
```

**Critical field**: `modelRegistry` — this is used by `PlanningService` to resolve API keys for LLM calls. The SDK builds it from:
1. Explicit API key → `AuthStorage.inMemory({ provider: { type: 'api_key', key } })`
2. No explicit key → `AuthStorage.create('~/.pi/agent/auth.json')` + `ModelRegistry.create(auth, '~/.pi/agent/models.json')`

**For OpenClaw**: Build `ModelRegistry` from OpenClaw's config-provided API key, falling back to pi config files if available.

## 5. Service Initialization — Exact Sequence

```
1. registerCoreServices()          — Registers: Scheduler, HealthCheckCache, Planning, ResearchOrchestration
2. registerInfrastructureServices() — Registers 18 infrastructure services
3. initializeCoreServices(ctx)     — Initializes all critical + eager services, passing ctx:
   Critical (always initialized):
     - MetricsService
     - ProcessLifecycleService
     - StatePathConfiguration
     - FileLockService
     - StateBackupManager
     - StateSessionManager
     - StateBrowserManager
     - StateMetricsCollector
     - StateValidator
     - GPUResourceService
     - StateManagerService
     - HealthCheckService
   Eager:
     - PlanningService (receives ctx → stores ctx.modelRegistry)
   Lazy (on first getService() call):
     - SchedulerService
     - KnowledgeStoreService
     - ResearchOrchestrationService
     - WorkerPoolManager
```

**For OpenClaw**: Same sequence, same mock ctx. Works identically to SDK mode.

## 6. Config Mapping — OpenClaw → pi-research

| OpenClaw Config Key | pi-research Config Field | Env Var Override | Default |
|--------------------|-------------------------|-----------------|---------|
| `apiKey` | (used for ModelRegistry, not Config) | — | — |
| `timeoutMs` | `RESEARCHER_TIMEOUT_MS` | `PI_RESEARCH_TIMEOUT_MS` | 300000 |
| `maxResearchers` | `MAX_CONCURRENT_RESEARCHERS` | `PI_RESEARCH_MAX_RESEARCHERS` | 3 |
| `defaultDepth` | `DEFAULT_RESEARCH_DEPTH` | `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` | 1 |
| `maxScrapeBatches` | `MAX_SCRAPE_BATCHES` | `PI_RESEARCH_MAX_SCRAPE_BATCHES` | 2 |
| `maxConcurrentScrapes` | `MAX_CONCURRENT_SCRAPES` | `PI_RESEARCH_MAX_CONCURRENT_SCRAPES` | 3 |
| `workerThreads` | `WORKER_THREADS` | `PI_RESEARCH_WORKER_THREADS` | 4 |
| `workerConcurrency` | `WORKER_CONCURRENCY` | `PI_RESEARCH_WORKER_CONCURRENCY` | 2 |
| `knowledgeEnabled` | `GLOBAL_KNOWLEDGE_STORE_ENABLED` + `LOCAL_KNOWLEDGE_STORE_ENABLED` | `PI_RESEARCH_GLOBAL_KNOWLEDGE_ENABLED` / `PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED` | true |
| `embeddingModel` | `EMBEDDING_MODEL` | `PI_RESEARCH_EMBEDDING_MODEL` | Xenova/all-MiniLM-L6-v2 |
| `embeddingDevice` | `EMBEDDING_DEVICE` | `PI_RESEARCH_EMBEDDING_DEVICE` | webgpu |
| `cacheTtlDays` | `KNOWLEDGE_STORE_CACHE_TTL_DAYS` | `PI_RESEARCH_CACHE_TTL_DAYS` | 30 |
| `scrapeTimeoutMs` | `SCRAPE_TIMEOUT_MS` | `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | 15000 |
| `model` | `RESEARCH_MODEL` | `PI_RESEARCH_MODEL` | (empty = context model) |
| `searxngUrl` | (env only) | `SEARXNG_URL` | (empty) |

**Strategy**: OpenClaw config values are mapped to pi-research's `Config` object via `setConfig()` before initialization. Env vars continue to work as overrides (highest priority).

## 7. Implementation Plan — Exact Files

### 7.1 `openclaw.plugin.json` (NEW — ~50 lines)

Static manifest declaring:
- Plugin identity (`id: "pi-research"`)
- Config schema (maps to pi-research config fields)
- Tool contracts (`contracts.tools: ["research", "health"]`)
- Activation metadata (`onStartup: true`)
- Setup providers (env vars for SearXNG, StackExchange, etc.)
- UI hints for config surface

### 7.2 `src/openclaw-entry.ts` (NEW — ~150 lines)

The OpenClaw plugin entry point:

```
Structure:
1. Lazy initialization state (same pattern as SDK)
2. ensureInitialized(config, context) — builds ModelRegistry, creates mock context, registers+initializes services
3. defineToolPlugin with 2 tools:
   - research: params { query, depth(0-3, default 1), excludeTools }
   - health: params { verbose, probe }
4. Tool execute() maps OpenClaw context → pi-research mock context
5. Routes depth 0 → QuickResearchOrchestrator, depth 1-3 → DeepResearchOrchestrator(complexity=depth)
6. Uses HeadlessObserver (no TUI)
```

Key implementation details:
- Default depth = 1 (not 0, matching user's request "hard-coded to depth 1")
- Depth 0-3 all enabled (matching SDK mode)
- Uses `HeadlessObserver` with optional `onProgress` callback from config
- `excludeTools` defaults to `['grep', 'read']` for OpenClaw (these tools need pi's agent runtime and aren't useful in OpenClaw context)
- Model resolution: OpenClaw provides `context.activeModel` with `{ provider, modelId }`, map to pi's `Model` type

### 7.3 `package.json` Changes (MODIFIED — ~8 lines)

```json
{
  "openclaw": {
    "extensions": ["./dist/openclaw-entry.js"],
    "compat": {
      "pluginApi": ">=2026.5.17"
    }
  },
  "files": [
    "src/",
    "dist/",
    // ... existing entries
  ],
  "scripts": {
    "build:openclaw": "esbuild src/openclaw-entry.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/openclaw-entry.js",
    "prepublishOnly": "npm run build:worker && npm run build:openclaw"
  }
}
```

### 7.4 What Does NOT Change

| File | Why It Doesn't Need Changes |
|------|---------------------------|
| `src/index.ts` | Pi extension entry — untouched |
| `src/sdk.ts` | Programmatic SDK — untouched |
| `src/tool.ts` | Tool factory exports — used by both entry points |
| `src/tools/*` | Tool implementations — pure logic |
| `src/core/*` | Services — work with mock context |
| `src/orchestration/*` | Orchestrators — work with mock context |
| `src/web-research/*` | Search/scrape — pure logic |
| `src/knowledge/*` | Knowledge store — pure logic |
| `src/config.ts` | Config — env-based, works everywhere |
| `src/logger.ts` | Logging — pure logic |
| `src/tui/*` | TUI — guarded by `ctx.hasUI === false`, never activated |
| `src/healthcheck/*` | Health checks — pure logic |
| `src/infrastructure/*` | Browser pool, state — pure logic |
| All tests | Unchanged — test pi extension path |

## 8. Model Resolution — The Tricky Part

OpenClaw's `context.activeModel` provides:
```typescript
{
  provider: string,    // e.g., "openai"
  modelId: string,     // e.g., "gpt-4o"
  modelRef: string,    // e.g., "openai/gpt-4o"
}
```

pi-research needs a `Model<any>` object with at minimum:
```typescript
{
  id: string,          // model ID
  provider: string,    // provider name
  // ... plus cost, context window info for PlanningService
}
```

**Resolution strategy** (in order of priority):
1. Try `ModelRegistry.find(provider, modelId)` using pi's config files (if they exist)
2. If not found, construct a minimal `Model` object from OpenClaw's model info:
   ```typescript
   {
     id: activeModel.modelId,
     provider: activeModel.provider,
     cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
     contextWindow: 128000,
   }
   ```
3. API key resolution: use the key from OpenClaw config → `AuthStorage.inMemory()`

## 9. What Happens to `read` and `grep` Tools

The `read` and `grep` tools come from `@earendil-works/pi-coding-agent`:
- `createReadTool(cwd)` — reads files, used by researcher agents for local code
- `createGrepToolDefinition(cwd)` — searches code, used by researcher agents

**For OpenClaw**: These are pi-specific developer tools. Researchers don't need them for web research. Default `excludeTools` for OpenClaw should include `['grep', 'read']`. The remaining tools (search, scrape, links, security, stackexchange) are all self-contained and have no pi dependencies.

Actually, looking more carefully at `createReadTool` — it's imported from `pi-coding-agent` and used directly. If pi-coding-agent is available at runtime (which it must be for `createAgentSession`), then `createReadTool` will also work. The question is whether it makes **sense** in OpenClaw context.

**Decision**: Exclude `grep` and `read` by default for OpenClaw. They're developer tools that don't add value for web research in an agent platform context. Users can override via `excludeTools` config if they want them.

## 10. Risk Analysis

### LOW RISK
- **Service initialization**: Identical to SDK mode, which is battle-tested
- **Config**: All env vars continue to work; OpenClaw config is additive
- **Knowledge store**: Optional feature, disabled by default if LanceDB/embedding fails
- **Browser pool**: Lazy initialization, works the same everywhere

### MEDIUM RISK
- **Model resolution**: If OpenClaw's model info doesn't match pi's `Model` type expectations, cost tracking and context window calculations may be inaccurate. Mitigated by providing sensible defaults.
- **`createAgentSession` stability**: This function is from pi-coding-agent and may change across versions. Pinning peerDependency version range mitigates this.

### ACCEPTED RISK
- **pi-coding-agent as runtime dependency**: OpenClaw users must install it. This is declared as a peerDependency and the npm install will pull it in. It's the sub-agent runtime — there's no way around it without a massive refactor.

## 11. Estimated Effort

| Task | New Lines | Changed Lines |
|------|-----------|---------------|
| `openclaw.plugin.json` | ~50 | 0 |
| `src/openclaw-entry.ts` | ~150 | 0 |
| `package.json` | ~8 | 0 |
| **Total** | **~208** | **0** |

**No existing code is modified.** The integration is purely additive.

## 12. Implementation Order

1. Create `openclaw.plugin.json` — static metadata, no logic
2. Create `src/openclaw-entry.ts` — OpenClaw entry point
3. Update `package.json` — add `openclaw` key and build script
4. Add esbuild build for OpenClaw entry
5. Test locally with OpenClaw installation
6. Publish to ClawHub
