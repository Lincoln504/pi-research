## SDK

The programmatic SDK for scripts, CI, and custom tooling. For configuration — the
layering model, the TUI settings, and every environment variable — see
[CONFIGURATION.md](CONFIGURATION.md).

`src/sdk.ts` is a library for scripts, CI, and custom tooling. It is configured
from code, not from a global overlay file — there is no `sdk.env`. It reads the
base `~/.pi/research/config.env` as a baseline, and everything is
overridable via `options.config`. Pass `ignoreGlobalConfig: true` to ignore the
global file entirely and run purely from defaults + `process.env` + `options.config`
— self-contained and reproducible from code.

> Runtime requirement. The package exports (`.` and `/sdk`) resolve to
> TypeScript source — there is no transpiled `dist/sdk.js`. Import it from a
> TypeScript-aware runtime: the pi host (which loads it natively), Node ≥ 22.6
> with type stripping (`node --experimental-strip-types your-script.ts`, the
> default from Node 23.6+), or a loader such as `tsx` / `ts-node`. Plain
> `node script.js` doing `require('@lincoln504/pi-research/sdk')` will not work.
> (`engines.node` is `>=22.19.0`, so a supported install already meets this.)

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

The SDK does not write report files. Report export is a front-end concern — the pi
extension and the CLI / agent skill do it when `PI_RESEARCH_REPORT_EXPORT_ENABLED=true`.

### Init options

| Option | Description |
|--------|-------------|
| `model` | `"provider/id"` string or a `Model` object. Omit to use the first available pi model. |
| `apiKey` / `provider` | Explicit credentials (provider required with apiKey). |
| `config` | `Partial<Config>` overrides, applied over the base/defaults. |
| `ignoreGlobalConfig` | Skip `config.env` entirely — defaults + `process.env` + `config` only. |
| `cwd` | Working directory for logs and the knowledge store. |
| `verbose` | Mirror logs to the console. |

For configuration precedence, the per-front-end overlays, and the full
environment-variable reference, see [CONFIGURATION.md](CONFIGURATION.md). Note that
the SDK is configured from code and has no overlay file — pass `ignoreGlobalConfig: true`
for a hermetic run.

### Health & knowledge-store APIs

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
is model-dependent (auto-detected); stored fields are `text`, `content`,
`vector`, `url`, `metadata`, `timestamp`, `workspace`, `is_global`, and
`ingestion_type`.
