## SDK

A high-level research SDK for scripts, CI, and custom tooling. For configuration (the
layering model, the TUI settings, and every environment variable) see
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
available model in your pi registry. The API key comes from your pi
configuration (`~/.pi/agent/auth.json`) automatically, or from the `apiKey`
option / `PI_RESEARCH_API_KEY` env var.

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
> - the pi host, which loads it natively (via `jiti`);
> - a loader such as `tsx` or `ts-node`.
>
> **Bare Node cannot load it at all, with any flag.** Node refuses to strip or
> transform TypeScript that lives under `node_modules` — as an installed
> dependency's source does — failing with
> `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. That applies to
> `--experimental-transform-types` exactly as it does to
> `--experimental-strip-types`, so neither flag helps here; a loader (or the pi
> host) is mandatory. (`engines.node` is `>=22.19.0`.)

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
`getLastRunMetrics`, `getLastRunSummary`, `getLastErrorReport`, and
`getLastResearcherOutcome` (planned/launched/succeeded/failed researcher counts plus
per-researcher failure reasons for the most recent run — lets a caller tell a thin
report caused by a sparse topic apart from one where most researchers failed). Both
`@lincoln504/pi-research` and `@lincoln504/pi-research/sdk` export these symbols.

> Concurrency: a single initialized SDK instance runs one research call at a time.
> Overlapping `runDeepResearch`/`runQuickResearch` calls on the same instance throw
> — run them sequentially, or use a separate process per concurrent run.
>
> Separate processes are additionally bounded by a **machine-wide run cap**
> (`PI_RESEARCH_MAX_CONCURRENT_RUNS`, default 3) covering every pi-research process
> on the host, because they all share one leader-elected browser/embedding pool. A
> run over the cap queues for up to `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` (default
> 10 min) and only then rejects with `ResearchRunCapacityError` — a temporary
> "try again shortly" condition, surfaced by the CLI as exit code `75`. Supply an
> observer with `onRunQueued(slots, maxWaitMs)` to tell a waiting user the run is
> queued rather than hung.

### Cancellation

`runDeepResearch`, `runQuickResearch`, `verifyUrl` and `scrapeUrl` all take an
optional `AbortSignal` as their **last positional argument** (not a field of the
options object):

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

const markdown = await runDeepResearch('…', { depth: 2 }, controller.signal);
```

The orchestrator checks the signal at every round boundary and threads it into
search, scraping and the LLM calls, so an abort stops work rather than merely
detaching from it.

**An abort does not always reject.** The outcome depends on whether anything was
collected before the signal arrived:

| State when aborted | Result | Observer |
|---|---|---|
| At least one researcher report collected | **Resolves** with a partial synthesis built from what was gathered | `onComplete` |
| Nothing collected yet | **Rejects** (`Research aborted` / `Research cancelled`) | `onError` |

So a caller must not treat "resolved" as "ran to completion" when it aborted the
run itself — check your own signal, not just the promise. Exactly one of
`onComplete` / `onError` fires either way.

The CLI reports cancellation through the exit code, always: a signalled run exits
in the cancellation range — **`128 + signal`** (`130` Ctrl-C/SIGINT, `143` SIGTERM,
`129` SIGHUP, `131` SIGQUIT) — and a programmatic abort where no signal was involved
exits `130`. A cancelled run never exits `0`, because `0` means the research
succeeded and an agent relaying it would report a completed run to the user.

Whether a *partial* report reaches stdout first depends on how far the run got
before the abort landed: the handler aborts the in-flight run before tearing down,
so an orchestrator that can still synthesise what it gathered may print that
material ahead of the exit. Treat it as a best-effort bonus, not a guarantee — the
exit code is the part you can rely on.

Treat any code ≥ 128 as a cancellation; `pi-research --help` lists the full set, and
the agent-facing contract is the exit-code table in
[`SKILL.md`](../agent-skill/pi-research/SKILL.md).

These are deliberately not the `70` runtime-error code and never carry
`retryable: true` — a cancel is a completed intention, not a fault to retry. The
codes are derived per-signal rather than fixed because the CLI *handles* those
signals rather than dying from them: a fixed code would make the observed exit
status depend on whether the handler beat a force-kill, whereas `128 + N` matches
what the shell reports either way.

You still must call `shutdownResearchSDK()` afterwards: aborting a run releases
that run, not the browser pool, LanceDB handles or worker processes.

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
