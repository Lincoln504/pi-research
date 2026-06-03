# Development

## Setup

```bash
git clone https://github.com/Lincoln504/pi-research.git
cd pi-research
npm install
cp .env.example src/.env   # edit as needed
npm run build:worker       # required before integration tests
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run lint` | ESLint (src/ only) |
| `npm run lint:fix` | ESLint with auto-fix |
| `npm run type-check` | tsc on src/ |
| `npm run type-check:tests` | tsc on src/ + test/ |
| `npm run test:unit` | Unit tests (fast, no browser) |
| `npm run test:integration` | Integration tests (parallel + serial groups) |
| `npm run test:coverage` | Unit tests with v8 coverage report |
| `npm run test:full` | Unit + integration + load |
| `npm run deps:check` | Enforce dependency rules (depcruise) |
| `npm run deps:generate` | Regenerate docs/deps.svg (requires graphviz) |
| `npm run build:worker` | Bundle thread-worker.ts → thread-worker.mjs (esbuild) |
| `npm run models:download` | Pre-download embedding model to local cache |

---

## Tests

### Structure

```
test/
├── unit/         fast, no browser, all dependencies mocked
├── integration/  real browser pool and knowledge store
├── load/         sustained concurrency (slow, run manually)
└── stress/       chaos/jitter scripts (Node.js .mjs, run manually)
```

### Unit Tests

Run with `npm run test:unit`. No browser or model required. All external services are mocked.

### Integration Tests

Split into two vitest projects:

- **Parallel group** — knowledge store, embedder, migrations, setup/shutdown. No shared singletons — each file uses an isolated tmpdir database.
- **Serial group** — browser pool lifecycle, orchestrator flows, tool execution, error recovery. Must run sequentially.

**Local prerequisites:**
```bash
npx camoufox-js fetch          # download camoufox binary (~300 MB)
# Linux only:
Xvfb :99 -screen 0 1920x1080x24 -ac &
export DISPLAY=:99
npm run build:worker
npm run test:integration
```

**CI mock mode** — CI sets `PI_RESEARCH_MOCK_SEARCH=true` and `PI_RESEARCH_MOCK_SCRAPE=true`. When both are set, `isBrowserAvailable()` returns false and browser-pool tests skip gracefully. This avoids a FixedClusterPool deadlock that occurs in Vitest's fork context with real browser workers. Knowledge store and orchestration tests still run.

### Load & Stress Tests

Load tests (`test/load/`) run extended concurrent scenarios. Stress scripts (`test/stress/*.mjs`) run chaotic scheduling patterns. Neither runs in CI — trigger manually.

---

## CI/CD

CI runs on every push and pull request. Jobs:

| Job | Trigger | What it does |
|-----|---------|--------------|
| `analyze` | all pushes | CodeQL security scan |
| `lint` | all pushes | ESLint + npm audit |
| `type-check` | all pushes | tsc (src + tests) |
| `unit-test` | after lint+type-check | all unit tests |
| `integration-test` | after lint+type-check | both integration groups (mock mode) |
| `dep-graph` | after lint+type-check | dep rules check + regenerate docs/deps.svg |
| `validate` | all pushes | package.json sanity + npm pack dry-run |

The `dep-graph` job commits an updated `docs/deps.svg` back to the branch on any push (skipped on fork PRs where `contents:write` is unavailable).

---

## Adding a Tool

1. Implement the tool function in `src/tools/`.
2. Register it in the tool definitions file used by the orchestrators.
3. Add unit tests in `test/unit/tools/`.
4. Add the tool name to the researcher system prompt if it should be available during gathering.
5. Run `npm run deps:check` to ensure no new circular dependencies.

---

## Adding a Service

1. Define the interface in `src/core/interfaces/` or `src/core/service-interfaces.ts`.
2. Implement the service class, implementing `IService` (`initialize?`, `dispose?`).
3. Register in `src/core/service-initialization.ts` or `src/infrastructure/service-initialization.ts`.
4. Add unit tests using `resetServiceContainer()` in `beforeEach`.
5. Run `npm run deps:check`.

---

## Publishing

Bump `version` in `package.json`, then:

```bash
npm publish
```

`prepublishOnly` runs `build:worker` automatically. The published package includes `src/`, the bundled worker (`src/infrastructure/browser/thread-worker.mjs`), `docs/SDK.md`, `docs/ARCHITECTURE.md`, `scripts/setup.cjs`, `scripts/cleanup.cjs`, `LICENSE`, and `README.md`.
