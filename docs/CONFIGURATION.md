## Configuration

Every front-end (the pi extension, the standalone CLI / agent skill that OpenClaw
and other skills-aware hosts run, and the SDK) shares one configuration
model. This document covers the
settings exposed in the `/research-config` TUI first, then the complete
environment-variable reference, and finally how the configuration layers resolve.

![The /research-config settings TUI](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/04-config.gif)

### Settings in the TUI

Run `/research-config` in the pi extension to open an interactive menu. Selecting a
setting and pressing `Enter` / `Space` cycles its value; the change is saved
immediately. A setting is written to one of two scopes:

- `[project]` — saved per working directory in the central project registry, so
  a given repo can carry its own value without changing your global default.
- user — saved to the shared base file (`config.env`), applying to every
  directory and front-end unless a higher layer overrides it.

| Setting | Scope | Values | Env var |
|---------|-------|--------|---------|
| `/research` depth | project | normal · deep · ultra | `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` |
| Knowledge Mode | project | none · project · global | `PI_RESEARCH_KNOWLEDGE_STORE_MODE` |
| Researcher Timeout | user | 3 · 5 · 10 · 15 · 20 · 30 (minutes) | `PI_RESEARCH_TIMEOUT_MS` |
| Max Concurrency | user | 1 – 5 | `PI_RESEARCH_MAX_RESEARCHERS` |
| Scrape Batches | user | unlimited · 1 · 2 · 3 · 5 · 10 · 15 | `PI_RESEARCH_MAX_SCRAPE_BATCHES` |
| Auto-export Report | user | true · false | `PI_RESEARCH_REPORT_EXPORT_ENABLED` |
| Embedding Model | user | one of the supported models | `PI_RESEARCH_EMBEDDING_MODEL` |
| Embedding Device | user | GPU · CPU | `PI_RESEARCH_EMBEDDING_DEVICE` |
| Cache Retention | user | 7 · 14 · 30 · 60 · 90 · 180 · 365 (days) | `PI_RESEARCH_CACHE_TTL_DAYS` |
| Debug Logging | user | true · false | `PI_RESEARCH_DEBUG` |

Embedding Device offers two choices in the menu. GPU maps to the
auto-detect path: pi-research probes whether WebGPU actually runs on this machine
and falls back to CPU if it does not. CPU forces CPU-only
inference. Raw forced-GPU (no probe) is reachable only through the
`PI_RESEARCH_EMBEDDING_DEVICE=webgpu` environment variable, for benchmarking — see
the [knowledge store doc](KNOWLEDGE-STORE.md).

The Embedding Model, Embedding Device, and Cache Retention rows appear
only when Knowledge Mode is not `none`.

The menu also offers actions that are not settings: Run Health Check, Store
Status, Clear Project / User Store, Session Metrics, Clear Debug Logs, and
Install / Remove in External Agents (the coding-agent
skill installer). Browser worker count is deliberately not in the menu — it is
CPU/RAM-sensitive and set only via `PI_RESEARCH_WORKER_THREADS`.

### Environment variables

Every setting is also an environment variable. The repo's
[`.env.example`](https://github.com/Lincoln504/pi-research/blob/main/.env.example)
is the canonical, exhaustive list with inline notes; this section groups the same
variables with their defaults and valid ranges.
Out-of-range numeric values are clamped (with a warning); an invalid enum value
falls back to the default (with a warning).

The TUI-exposed variables are marked `(TUI)`. The `[project]` mark indicates a
project-scoped key (saved per directory in the registry); all others are
user-scoped.

Research

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_TIMEOUT_MS` (TUI) | `300000` | 180000–1800000 | Per-researcher timeout (3–30 min). |
| `PI_RESEARCH_MAX_RESEARCHERS` (TUI) | `3` | 1–5 | Parallel researchers. |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` (TUI) `[project]` | `1` | 1–3 | Depth for `/research` and the CLI when `--depth` is omitted (1=normal, 2=deep, 3=ultra). |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES` (TUI) | `2` | 0–99 | Scrape batches per researcher (0 = unlimited). |
| `PI_RESEARCH_MAX_GATHERING_CALLS` | `12` | 1–100 | Shared web-gathering calls per researcher (`search` + `security_search` + `stackexchange` + `youtube_transcript`). |
| `PI_RESEARCH_MAX_CONCURRENT_SCRAPES` | `3` | 1–20 | Concurrent URLs fetched per scrape batch. |
| `PI_RESEARCH_MAX_RETRIES` | `2` | 0–5 | Retries per researcher request. |
| `PI_RESEARCH_RETRY_DELAY_MS` | `2000` | 100–10000 | Base delay between retries. |
| `PI_RESEARCH_MAX_FAILED_RESEARCHERS` | `2` | 1–10 | Unique researcher failures that abort the whole run. Raise to let slower, still-in-flight researchers finish before giving up. |
| `PI_RESEARCH_WORKER_THREADS` | `4` | 1–10 | Browser worker processes. Higher = more throughput, more CPU/RAM. |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `2` | 1–10 | Tasks per worker process. |
| `PI_RESEARCH_MAX_CONCURRENT_RUNS` | `3` | ≥1 | Machine-wide cap on research runs executing at the same time, across **every** process (CLI, agent skill, pi extension, SDK). Runs beyond the cap queue rather than fail. All concurrent runs share one leader-elected browser/embedding pool, so oversubscribing it degrades every run at once. |
| `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` | `600000` | ≥0 | How long a run queues for a free slot before failing with "maximum concurrent research runs reached" (CLI exit `75`). `0` = fail immediately instead of queueing. |
| `PI_RESEARCH_MODEL` | _(pi: session model; CLI/skill: required)_ | — | The model research runs on. **Required for the standalone CLI / agent skill** — they use only this configured model (never the model selected inside the pi extension) and refuse to start without one (the CLI's per-run `--model` flag also satisfies this). On the SDK it selects the session model when no `model` option is given. In the pi extension it overrides researcher sub-agents and knowledge synthesis, while the coordinator and evaluator keep using the session model. Accepts `provider/id` or a bare model id. |
| `PI_RESEARCH_DISABLED_TOOLS` | _(none)_ | — | Comma-separated research tools to disable for a run (`search`, `scrape`, `security_search`, `stackexchange`, `youtube_transcript`, `grep`, `read`). Removed from every researcher's toolset and named in the coordinator/evaluator prompt. Strictly additive — it can only remove capabilities, never grant one, and it stacks on top of the default exclusions rather than replacing them. An unrecognized name excludes nothing and is warned about rather than failing the run. |
| `PI_RESEARCH_REPORT_EXPORT_ENABLED` (TUI) | `false` | — | Front-ends write a Markdown report to disk and surface its path. |
| `PI_RESEARCH_REPORT_EXPORT_DIR` | _(smart cwd)_ | — | Pin exported reports to a fixed directory, bypassing the cwd-relative resolution. Useful for the agent skill, which runs from the host agent's arbitrary directory. |
| `PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING` | `0.15` | 0.05–1.0 | Max fraction of the context window used for initial scrape context. |
| `PI_RESEARCH_AVG_TOKENS_PER_SCRAPE` | `2500` | 500–10000 | Estimated tokens per scrape result, used for planning. |

YouTube transcripts

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS` | `3` | 1–5 | Videos transcribed per `youtube_transcript` call. |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_TIMEOUT_MS` | `20000` | 5000–120000 | Per-video transcript timeout. |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG` | `en` | — | Preferred caption language (BCP-47 prefix). |
| `PI_RESEARCH_YOUTUBE_QUERY_EVERY_N` | `5` | 1–100 | Append `youtube` to roughly one-in-N search queries (1 = every query). |
| `PI_RESEARCH_YOUTUBE_POTOKEN_REQUEST_KEY` | _(built-in)_ | — | Advanced: override the BotGuard PoToken web request key (only if YouTube rotates the public key and transcripts start failing). |

Timeouts

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_TIMEOUT_MS` | `300000` | 60000–1800000 | Coordinator / evaluator / repair / knowledge LLM call timeout. |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | 5000–120000 | Per-page scrape (page-load) timeout. |
| `PI_RESEARCH_SEARCH_TIMEOUT_MS` | `45000` | 5000–120000 | Browser search page timeout. |
| `PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS` | `10000` | 2000–120000 | Queue-wait / overhead margin added to each browser op's own timeout (a search task ceiling is `SEARCH_TIMEOUT_MS` + this; a scrape is `SCRAPE_TIMEOUT_MS` + this). |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `10000` | 2000–120000 | Pre-flight health-check timeout. |

LLM output & reasoning

These are advanced, env-only knobs (not in the TUI).

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_THINKING_LEVEL` | `off` | off · minimal · low · medium · high | Chain-of-thought level for all engine LLM work (coordinator, evaluator, synthesis, JSON-repair, knowledge extraction, and researcher sub-agents). Off by default — these calls emit structured JSON / cited reports, so a thinking block only consumes the output budget and can truncate the answer. Clamped per model by pi. |
| `PI_RESEARCH_PLANNING_MAX_TOKENS` | `16384` | 1024–131072 | Max output tokens for the plan + mid-round evaluator decision. Clamped to the model's real ceiling. |
| `PI_RESEARCH_SYNTHESIS_MAX_TOKENS` | `32768` | 1024–131072 | Max output tokens for the final synthesized report. Clamped to the model's real ceiling. |

Knowledge store

See the [knowledge store doc](KNOWLEDGE-STORE.md) for what each value does.

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `PI_RESEARCH_KNOWLEDGE_STORE_MODE` (TUI) `[project]` | `global` | none · project · global | Store scope: one shared store across every directory (`global`), scoped to the current directory (`project`), or disabled (`none`). |
| `PI_RESEARCH_EMBEDDING_MODEL` (TUI) | `onnx-community/granite-embedding-small-english-r2-ONNX` | — | Embedding model. Changing it clears the store and starts fresh. |
| `PI_RESEARCH_EMBEDDING_DEVICE` (TUI) | `auto` | auto · webgpu · cpu | Inference backend. `auto` probes WebGPU viability out-of-process and falls back to CPU; `cpu` forces CPU; `webgpu` forces the GPU path with no probe (advanced — can hard-crash on a software GPU). The TUI exposes only `auto` (as "GPU") and `cpu`. |
| `PI_RESEARCH_CACHE_TTL_DAYS` (TUI) | `30` | 1–365 | How long cached findings are kept before eviction. |
| `PI_RESEARCH_KNOWLEDGE_STORE_MAX_SERVE_AGE_DAYS` | `0` | 0–3650 | Max age a cached scrape may be *served* at read time before it's treated as a miss and re-scraped fresh. `0` = disabled (serve at any age up to the TTL). Cache age is always surfaced to the model regardless. |
| `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` | drop · backup · re-embed | What to do with stored data when the embedding model changes. |
| `PI_RESEARCH_KNOWLEDGE_DIR` | _(auto)_ | — | Override the knowledge-store database directory. Default: `~/.pi/research/knowledge_db`. |
| `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` | 10000–600000 | Embedding-model initialization timeout (first-time download can be slow). |
| `PI_RESEARCH_WEBGPU_REPROBE` | _(unset)_ | — | Set `1` to discard the cached WebGPU-viability verdict and probe again on next use. |

API keys

| Variable | Description |
|----------|-------------|
| `PI_RESEARCH_API_KEY` / `PI_RESEARCH_PROVIDER` | Explicit LLM credentials for SDK / CLI mode (not needed when pi's configuration supplies the key). On the CLI / agent skill both can also live in `config.env` / `cli.env`. The provider is required alongside the key, or inferred from a `provider/model-id` `PI_RESEARCH_MODEL`. Note: provider-native variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) are honored only as **real environment variables** — placing one in `config.env` / `cli.env` does nothing (the files bridge only `PI_RESEARCH_*` keys plus `STACKEXCHANGE_API_KEY` / `GITHUB_TOKEN` / `NVD_API_KEY`). |
| `STACKEXCHANGE_API_KEY` | Raises the Stack Exchange tool's limit from 300/day to 10,000/day. Obtain at <https://stackapps.com/apps/oauth>. |
| `GITHUB_TOKEN` | Raises the security tool's GitHub Advisory limit from 60/hr to 5000/hr (any default-scope token). |
| `NVD_API_KEY` | Raises the security tool's NVD limit ~10× and tightens request spacing. Request at <https://nvd.nist.gov/developers/request-an-api-key>. Recommended when using severity-filtered security searches: those issue a second (CVSS v2) NVD query to catch v2-only CVEs, which roughly doubles request time against the 6 s/request unauthenticated throttle. |

Diagnostics & platform

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_DEBUG` (TUI) | `false` | Verbose INFO+DEBUG logging to the log file. |
| `PI_RESEARCH_CONSOLE_LOG` | `false` | Mirror logs to stdout/stderr (useful in CI / headless). |
| `PI_RESEARCH_LOG_PATH` | _(OS temp)_ | Override the verbose log file path. Browser workers inherit it automatically. |
| `PI_RESEARCH_LOG_FILE` | _(unset)_ | Send browser worker-thread logs to a separate file. If unset, workers log to `PI_RESEARCH_LOG_PATH`. |
| `PI_RESEARCH_TMP_DIR` | `~/.cache/pi-research/profiles` | Transient per-worker browser-profile directory. Disk-backed by default (kept off a RAM-backed `/tmp` so per-worker profiles don't add memory pressure). Point under the system temp dir to opt into tmpfs/RAM. |
| `PI_RESEARCH_STATE_DIR` | `~/.pi/research/state` | Override the state directory (active sessions, browser status, project registry). |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `100` | TUI refresh debounce (0–1000 ms). |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | _(unset)_ | Set `1`/`true` to skip the pre-flight browser/embedding health check and rely on per-task timeouts. **Depth 0 (quick) only** — depth 1-3 runs have no such pre-flight check, so this has no effect on them. |
| `PI_RESEARCH_USE_XVFB` | _(unset)_ | Linux only. Bare-TTY runs are true-headless and need no X server; set `true` to opt into a virtual framebuffer (`sudo apt install xvfb`). |
| `PI_RESEARCH_SKILL_DIR` | _(auto)_ | Override the bundled research-skill source directory used by the skill installer. |
| `PI_RESEARCH_PURGE_BROWSERS` | _(unset)_ | Read by the bundled `scripts/cleanup.cjs`: set `1` to also delete the shared camoufox browser cache (kept by default because other installs may use it). Note npm ≥7 does not run `preuninstall`, so that script does not fire on `npm uninstall` — see [AGENT-SKILL.md](AGENT-SKILL.md). |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | _(unset)_ | Set `1` during `npm install` to skip the camoufox browser download (fetched lazily on first use instead; standard Playwright convention). |
| `CAMOUFOX_INSTALL_DIR` | _(user cache)_ | camoufox-js's own variable, and the only one that can relocate the browser. Sets where pi-research looks the binary up, and is exported to the postinstall fetch and to browser workers. **Not effective on the currently pinned camoufox-js (0.10.x), which hardcodes its cache directory and honours no variable** — so relocating the browser is unsupported until that pin can advance (see ARCHITECTURE.md). |
| `PLAYWRIGHT_BROWSERS_PATH` | _(user cache)_ | Alias for the above, accepted for compatibility and exported onward as `CAMOUFOX_INSTALL_DIR`. Same caveat: on the pinned camoufox-js it moves only where pi-research looks, not where the download lands, so setting it reports the browser missing from the custom path after a successful install. |
| `XDG_CACHE_HOME` | `~/.cache` | Standard XDG variable. When set, every `~/.cache/pi-research/...` path below is rooted at `$XDG_CACHE_HOME/pi-research/...` instead. |
| `PI_RESEARCH_BIN` (alias `PI_RESEARCH_PATH`) | _(auto)_ | Agent-skill launcher only: explicit path to the pi-research engine binary when auto-resolution (PATH → local install → npx) should be bypassed. See [skills/pi-research/references/configuration.md](../skills/pi-research/references/configuration.md). |
| `PLAYWRIGHT_INSTALL_DEPS` | _(unset)_ | Linux only. Set `true` during `npm install` to also install system libraries via `npx playwright install-deps` (same as `npm run install:system-deps`). |
| `PI_RESEARCH_STRICT_SETUP` | _(unset)_ | Read by the bundled `scripts/setup.cjs` during `npm install`. Set `1`/`true` to make a failed browser download fail the install instead of deferring it to first use. |
| `PI_RESEARCH_CONFIG_DIR_NAME` | `.pi` | Override the host config-directory name under your home dir (advanced; e.g. set to share another harness's config root). |

Testing only — never enable in production

| Variable | Description |
|----------|-------------|
| `PI_RESEARCH_MOCK_SEARCH` | Return fabricated search results instead of real web data. |
| `PI_RESEARCH_MOCK_SCRAPE` | Return fabricated scrape results instead of real page content. |
| `PI_RESEARCH_FORCE_READY` | Bypass readiness checks and run even when critical services failed to initialize. **pi extension only** — the CLI, agent skill and SDK do not consult it. |
| `PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE` | Permit scraping **loopback** addresses (`127.0.0.0/8`, `::1`, `*.localhost`, `::ffff:127.x`) so integration tests can drive the real browser and scrape pipeline against a local server. Deliberately scoped to loopback only: link-local `169.254.0.0/16` (cloud metadata) and RFC1918 LAN ranges stay blocked even with this set, at request time and at connect time. |

### How configuration is layered

Configuration resolves from the following layers, lowest to highest precedence
(later wins):

```
built-in defaults
  < ~/.pi/research/config.env                       (base, shared; edited by /research-config)
  < ~/.pi/research/{pi,cli}.env                      (optional per-front-end overlay)
  < legacy .pi-research.env in the cwd               (deprecated; auto-migrated to the registry)
  < project registry                                 (~/.pi/research/state/project-settings.json, per directory)
  < process.env                                      (real shell env always wins)
```

Base file. `config.env` holds your shared, user-scoped settings. The
`/research-config` TUI edits only this file (and the project registry) — never the
overlays or the merged view — so overlay values are never baked back into the base.

Per-front-end overlays. Each front-end reads only its own optional overlay,
layered over the shared base, so they can be configured independently. Exactly two
exist:

- `~/.pi/research/pi.env` — the pi extension
- `~/.pi/research/cli.env` — the standalone CLI / agent skill (the surface OpenClaw
  and other skills-aware hosts run)

The overlay files do not exist by default; create the one you need by hand. There is
intentionally no `sdk.env`: the SDK is a library configured from code (see
[SDK.md](SDK.md)), not from a global file.

Example — give the standalone CLI / agent skill its own model and depth without
touching the pi extension:

```sh
# ~/.pi/research/config.env   (shared baseline)
PI_RESEARCH_KNOWLEDGE_STORE_MODE=project

# ~/.pi/research/cli.env       (standalone CLI / agent skill only)
PI_RESEARCH_MODEL=openrouter/anthropic/claude-sonnet-4-6
PI_RESEARCH_DEFAULT_RESEARCH_DEPTH=2
```

Project registry. Project-scoped settings (research depth and knowledge-store
mode) are stored per directory in `project-settings.json`, keyed by normalized
working-directory path. They override the base and overlays for that directory only.
In the pi extension the `/research-config` TUI writes them. On the standalone CLI you can
set the knowledge-store mode per directory directly:

```sh
pi-research knowledge-config                       # show the mode here and where it comes from
pi-research knowledge-config set <none|project|global>   # pick ONE value
```

Under the agent skill you don't have to run this yourself — you ask the agent (e.g. "disable the
knowledge store here" / "make it project-scoped") and it runs the same command on your
behalf. Either way it lands in the registry (above `config.env` in precedence), so a
per-directory value overrides a machine-wide `config.env` default; a real environment
variable still outranks both.

process.env. A real environment variable always wins. For a one-off override,
just export the variable for that process.

> The base file is not loaded automatically by your shell. Either use the
> `/research-config` TUI (which writes it), export variables in your shell, or use a
> loader such as direnv. `.env.example` is a reference, not an active config file.

### Prompt caching

A research run re-sends a large, mostly-unchanged prompt many times: a researcher
re-sends its whole conversation (including every scraped page) on each tool turn, and
the evaluator re-sends the accumulated findings on each round. Every provider will
serve that repetition from a prompt cache at a fraction of the input price — but only
for an **exact prefix** of the request, and only if nothing that varies sits in front
of it.

What pi-research does about it. The research lead is split into two roles so that the
repetition is removed rather than merely discounted. The **router** decides each round
whether to continue, reading each report in full on the one round it arrives and only its
short coverage digest thereafter, instead of re-reading every report collected so far. The **synthesizer** runs once, at the end, and is the only
call that reads the reports in full. Before the split, one call did both jobs and re-sent
the whole corpus every round, so its input grew with the square of the round count. The
synthesizer's corpus is also budgeted against the model's context window: over budget, the
reports are reduced in partial passes and merged rather than truncated or rejected.

How often the router runs depends on the round budget. Depth 2 and 3 route on every round
but the last. Depth 1's base budget is two rounds and the last one is skipped, so a plain
depth-1 run never routes — but steering raises the budget (up to two extra rounds), and a
steered depth-1 run does route. That is also the depth-1 case carrying the most findings,
so it is where routing on digests rather than on the full corpus matters most.

On top of that, both lead prompts are laid out stable-part-first: they interpolate only
values fixed for the whole run (complexity, team size, query budget, disabled tools), and
everything that changes between rounds — root query, round number, agenda, executed
queries, steering, round-phase guidance — is appended afterwards as a `RUN CONTEXT`
block. Unit tests hold the layout in place; if you edit
`src/prompts/system-lead-router.md` or `src/prompts/system-lead-synthesizer.md`, keep
run-varying text out of them.

What your provider does about it depends on which API pi talks to (the provider's `api`
field in `~/.pi/agent/models.json`) and, on OpenAI-compatible endpoints, on one `compat`
key:

| Provider API | Behaviour |
|--------------|-----------|
| `anthropic-messages` | pi inserts `cache_control` breakpoints automatically — on the system prompt, the last tool definition, and the last user/assistant/tool-result block. Nothing to configure. |
| `openai-completions` | pi inserts the **same** Anthropic-style breakpoints into the OpenAI-shaped payload whenever `compat.cacheControlFormat` is `"anthropic"`. Auto-detection sets that key for exactly one case — OpenRouter routing to an `anthropic/*` model — so by default no markers are sent and the provider's own implicit prefix caching is relied on. That default is correct for OpenAI, DeepSeek, Gemini and GLM, which all cache implicitly. |
| `openai-responses` | No markers at any setting; implicit caching only. |

Note that the marker behaviour is gated on `cacheControlFormat`, **not** on the `api`
field — setting the key makes an `openai-completions` provider emit explicit breakpoints
exactly like an `anthropic-messages` one. That matters when reading the counters below:
on a provider you have configured this way, a zero cache read is not evidence that
markers are missing.

The gap is providers that need explicit markers but are reached over an OpenAI-compatible
endpoint and are not the one auto-detected case. Anything in that category (Qwen through
OpenRouter, or any gateway fronting Claude) caches **nothing at all**, silently and with
no error. Fix it per provider with a `compat` block:

```json
{
  "providers": {
    "openrouter": {
      "api": "openai-completions",
      "compat": {
        "cacheControlFormat": "anthropic",
        "sessionAffinityFormat": "openrouter",
        "sendSessionAffinityHeaders": true
      }
    }
  }
}
```

`cacheControlFormat: "anthropic"` forces the markers on. It is safe to set for a whole
provider: models that do not use markers ignore the extra field. The two session-affinity
keys ask OpenRouter to keep a conversation on the replica that warmed its cache; without
them OpenRouter falls back to hashing the first messages, which an agentic loop mutates.

`PI_CACHE_RETENTION=long` (a pi variable, not a pi-research one) requests 1-hour
retention where the provider supports it. It raises the cache-write multiplier from
1.25x to 2x, so it only pays off when a run's gaps between calls exceed the provider's
default window — nominally 5 minutes.

Measure before enabling it. On a direct probe against GLM over `anthropic-messages`, an
entry was still read back unchanged after **seven minutes at the default retention**, and
`long` produced an identical number — so on that route the doubled write multiplier buys
nothing. The nominal 5-minute figure is a floor providers are free to exceed, not a
deadline you can plan around.

Verifying it works. Set `PI_RESEARCH_DEBUG=true` and read the run log: every LLM call
records `llm_cache_read_tokens_total` and `llm_cache_write_tokens_total` alongside
`llm_tokens_total`, labelled by component (`coordinator` / `router` / `synthesizer` /
`researcher`).
Cache reads that stay at zero on a multi-turn researcher mean the prefix is not being
matched — usually a provider with a minimum cacheable prefix (commonly 1024–4096 tokens)
that short prompts never reach, or an explicit-marker provider missing the `compat` block
above. A counter that is absent rather than zero means the provider does not report
caching at all.

Cache **writes** are the weaker signal of the two. Several providers report reads and
omit writes entirely — OpenRouter and Z.ai's Anthropic-compatible endpoint both return
non-zero `cache_read` alongside a flat zero `cache_write` — so a zero there is normal and
says nothing about whether caching is working. Judge it by the read counter.

### Where files live

All pi-research state lives under its own namespace, `~/.pi/research/`:

| Path | Contents |
|------|----------|
| `~/.pi/research/config.env` | Shared base configuration (user-scoped settings). |
| `~/.pi/research/{pi,cli}.env` | Optional per-front-end overlays. |
| `~/.pi/research/state/project-settings.json` | Project registry (per-directory settings). |
| `~/.pi/research/state/` | Active sessions, browser status, locks. |
| `~/.pi/research/knowledge_db/` | The knowledge store (LanceDB), unless `PI_RESEARCH_KNOWLEDGE_DIR` is set. |
| `~/.cache/pi-research/profiles/` | Transient browser profiles, unless `PI_RESEARCH_TMP_DIR` is set. Rooted at `$XDG_CACHE_HOME` when that is set. |
| `~/.cache/pi-research/webgpu-viability.json` | Cached WebGPU-viability verdict (see the knowledge store doc). Rooted at `$XDG_CACHE_HOME` when that is set. |

Paths can be relocated with `PI_RESEARCH_STATE_DIR`, `PI_RESEARCH_KNOWLEDGE_DIR`,
and `PI_RESEARCH_TMP_DIR`.
