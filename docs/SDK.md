## SDK

The programmatic SDK for scripts, CI, and custom tooling. For configuration — the
layering model, the TUI settings, and every environment variable — see
[CONFIGURATION.md](CONFIGURATION.md).

### Install

Install it as a dependency of your project so the imports resolve — even if you already
run the `pi` extension, which keeps its own private copy your scripts can't import:

```bash
npm install @lincoln504/pi-research
```

Then pick the model: pass `model` to `initResearchSDK`, or set `PI_RESEARCH_MODEL`
(env or `~/.pi/research/config.env`). The SDK never follows the model selected
inside the pi extension; only when neither is set does it fall back to the first
available model in your pi registry.

`src/sdk.ts` is a library for scripts, CI, and custom tooling. It is configured
from code, not from a global overlay file — there is no `sdk.env`. It reads the
base `~/.pi/research/config.env` as a baseline, and everything is
overridable via `options.config`. Pass `ignoreGlobalConfig: true` to ignore the
global file entirely and run purely from defaults + `process.env` + `options.config`
— self-contained and reproducible from code.

> Runtime requirement. The package exports (`.` and `/sdk`) resolve to
> TypeScript source — there is no transpiled `dist/sdk.js`. It must run on a
> runtime that *transforms* TypeScript, not merely strips types: the source uses
> `enum` and constructor parameter properties, which Node's strip-only mode
> (`--experimental-strip-types`, the default since Node 23.6) rejects with
> `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Use one of:
> - the pi host, which loads it natively;
> - **`node --experimental-transform-types your-script.ts`** — must be passed
>   explicitly; full transform is not the default on any current Node release;
> - a loader such as `tsx` or `ts-node`.
>
> Plain `node script.js` doing `require('@lincoln504/pi-research/sdk')`, or
> `--experimental-strip-types`, will not work. (`engines.node` is `>=22.19.0`.)

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
`getLastRunStats`, and `getSessionMetrics`, plus `exportKnowledge` (write the
knowledge store to a web-consumable JSON file) and the post-run telemetry accessors
`getLastRunMetrics`, `getLastRunSummary`, and `getLastErrorReport`. Both
`@lincoln504/pi-research` and `@lincoln504/pi-research/sdk` export these symbols.

> Concurrency: a single initialized SDK instance runs one research call at a time.
> Overlapping `runDeepResearch`/`runQuickResearch` calls on the same instance throw
> — run them sequentially, or use a separate process per concurrent run.

The SDK does not write report files. Report export is a front-end concern — the pi
extension and the CLI / agent skill do it when `PI_RESEARCH_REPORT_EXPORT_ENABLED=true`.

### Init options

| Option | Description |
|--------|-------------|
| `model` | `"provider/id"` string or a `Model` object. Omit to use the configured `PI_RESEARCH_MODEL`; only when neither is set does the SDK fall back to the first available pi model. |
| `apiKey` / `provider` | Explicit credentials (provider required with apiKey). |
| `config` | `Partial<Config>` overrides, applied over the base/defaults. |
| `ignoreGlobalConfig` | Skip `config.env` entirely — defaults + `process.env` + `config` only. |
| `cwd` | Working directory for logs and the knowledge store. |
| `verbose` | Mirror logs to the console. |

For configuration precedence, the per-front-end overlays, and the full
environment-variable reference, see [CONFIGURATION.md](CONFIGURATION.md).

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

### Example Use

The [Wall of Shame](https://wallofshame.io) project ([repo](https://github.com/Lincoln504/wall-of-shame))
uses this SDK in its agent pipeline: it calls `initResearchSDK` and the research
entry points (`runQuickResearch` / `runDeepResearch`) per investigation, and uses
the `scrapeUrl`, `verifyUrl`, and `repairJson` exports directly.
