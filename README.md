![pi-research banner](assets/README-banner.jpg)

[![npm version](https://img.shields.io/npm/v/@lincolndeen/pi-research.svg)](https://www.npmjs.com/package/@lincolndeen/pi-research)

Multi-agent web research extension for [pi](https://github.com/mariozechner/pi). Runs parallel AI researchers against a self-hosted SearXNG search container, scrapes pages, queries security databases, and tracks everything in a real-time terminal UI.

<!-- GIF: record a `depth 2` run showing the TUI panel populate with 3 researchers, green flashes on tool calls, evaluator promotion, and synthesis output. ~30s loop. -->

---

## Contents

- [Capabilities](#capabilities)
- [Requirements](#requirements)
- [Install](#install)
- [Platform Setup](#platform-setup)
- [Usage](#usage)
- [Research Depth](#research-depth)
- [Configuration](#configuration)
- [Search Engines](#search-engines)
- [Terminal UI](#terminal-ui)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Development](#development)
- [Release](#release)

---

## Capabilities

- **Multi-agent deep research** — AI coordinator decomposes a query into parallel research tracks; an AI lead evaluator synthesizes or delegates further rounds
- **Quick mode** — single researcher for fast, focused queries with no coordinator overhead
- **Web search** — SearXNG running in Docker, aggregating Bing, Brave, Yahoo, Qwant, and DuckDuckGo
- **URL scraping** — fetch-first with Playwright/Chromium fallback for JavaScript-heavy pages; context-aware batching
- **Security databases** — NVD, CISA KEV, GitHub Advisories, OSV; filterable by CVE, severity, package, ecosystem
- **Stack Exchange** — Stack Overflow, SuperUser, AskUbuntu, ServerFault, and the full SE network
- **Local code search** — ripgrep (`rg`) with `grep` fallback
- **Real-time TUI** — per-researcher token and cost tracking with green/red flash on tool calls
- **Optional paid search** — inject Brave's official search API alongside free engines via env var

---

## Requirements

- Node.js `22.13.0` or any `24.x+` release (`.nvmrc` pins `22.13.0`)
- The `pi` CLI installed and configured with a model provider and API key
- Docker installed with the daemon running before any research call
- Internet access for search, scraping, Stack Exchange, and security database requests

Docker is required because pi-research runs SearXNG in a container. On first use it pulls `searxng/searxng:latest`, creates the `pi-searxng` container, waits for it to pass a health check, and reuses it for the session.

---

## Install

**From npm**

```bash
pi install npm:@lincolndeen/pi-research
```

Package name: `@lincolndeen/pi-research`. After installing, start pi normally with `pi`.

**From a checkout**

```bash
nvm use                  # optional: use the pinned Node version
npm install
cp .env.example .env     # optional: configure proxy, API keys, timeouts
pi install .
```

Load for a single session without installing:

```bash
pi -e ./index.ts
```

---

## Platform Setup

**macOS** — install and start Docker Desktop, then run `docker info` to confirm the daemon is ready. Then run `pi`.

**Linux** — install Docker Engine or Docker Desktop and start the daemon:

```bash
sudo systemctl start docker
docker info
```

If `docker info` fails with a permissions error, add your user to the `docker` group. The change requires logging out and back in:

```bash
sudo usermod -aG docker "$USER"
```

**Windows** — install and start Docker Desktop (use Linux containers). Confirm with `docker info` from PowerShell, then run `pi`. Docker Desktop named pipes are detected automatically; `DOCKER_SOCKET` is not required.

---

## Usage

Once installed, ask pi for web research. The extension registers a `research` tool and pi's model decides when to invoke it.

```text
Research "What is a binary search tree?"
Research the latest Node.js 22 release notes
Do a deep dive on CVE-2024-3094
```

The tool accepts a `depth` parameter controlling research intensity. Omit it (or ask directly) for quick mode.

---

## Research Depth

| Depth | Mode | Researchers | Target rounds | When to use |
|-------|------|-------------|---------------|-------------|
| 0 (default) | Quick | 1 | 1 | Focused questions, fast lookups |
| 1 | Normal | 2 | 2 | Technical topics, moderate breadth |
| 2 | Deep | 3 | 3 | Multi-faceted analysis, security research |
| 3 | Ultra | 5 | 5 | Exhaustive investigation |

The lead evaluator may add up to 2 bonus rounds beyond the target when it judges critical gaps remain. The hard cap is `targetRounds + 2` — at that point the orchestrator refuses delegation regardless of the evaluator's output and falls back to concatenating all researcher findings.

For deeper runs, ask pi explicitly: *"Do an exhaustive deep dive on…"* or *"Research this at depth 3."*

**Quick mode** runs a single researcher with no coordinator. The researcher has a fixed budget of 4 gathering calls (search, security search, Stack Exchange, grep) and 4 scrape calls, then writes its report and stops.

**Deep mode** adds an AI coordinator that decomposes the query into an agenda before any research starts. Each round runs researchers in parallel (up to 3 at a time). When a round finishes, the last researcher to complete is promoted to lead evaluator: it reviews all findings against the original agenda and either synthesizes a final report or delegates a new round of targeted queries. Additional rounds are created only when coverage is genuinely incomplete.

---

## Configuration

pi-research reads `process.env` at startup and does not load `.env` files automatically.

**Shell (macOS / Linux)**

```bash
export BRAVE_SEARCH_API_KEY=your_key
export PI_RESEARCH_VERBOSE=1
pi
```

**PowerShell (Windows)**

```powershell
$env:BRAVE_SEARCH_API_KEY='your_key'
$env:PI_RESEARCH_VERBOSE='1'
pi
```

**direnv (recommended, macOS / Linux)**

```bash
cp .env.example .envrc
echo 'export BRAVE_SEARCH_API_KEY=your_key' >> .envrc
direnv allow
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | — | Proxy for SearXNG outgoing requests (e.g. `socks5://127.0.0.1:9050`) |
| `BRAVE_SEARCH_API_KEY` | — | Enables `braveapi` engine alongside free engines (pay-as-you-go, $0.005/query) |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `240000` | Per-researcher timeout, 30 000–600 000 ms |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `15000` | SearXNG health check timeout |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `10` | Terminal UI refresh debounce |
| `PI_RESEARCH_VERBOSE` | — | Write JSONL diagnostic logs to your OS temp directory |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | — | Skip startup health check (set to `1` if engines are blocked) |
| `DOCKER_SOCKET` | platform default | Docker socket path override |
| `DOCKER_HOST` | — | Docker host URL override |
| `STACKEXCHANGE_API_KEY` | — | Stack Exchange API key (anonymous: 300 req/day; with key: 10 000/day) |

**Verbose diagnostics** — set `PI_RESEARCH_VERBOSE=1` to write JSONL logs to your temp directory as `pi-research-debug-{hash}.log`. No logs are created otherwise.

**Skipping the health check**

```bash
# macOS / Linux
export PI_RESEARCH_SKIP_HEALTHCHECK=1
pi
```

```powershell
# Windows
$env:PI_RESEARCH_SKIP_HEALTHCHECK='1'
pi
```

---

## Search Engines

Free engines active by default (configured in `config/default-settings.yml`), in priority order:

| Engine | Weight | Notes |
|--------|--------|-------|
| `bing` | 1.5 | Most reliable free engine for private low-volume instances |
| `brave` | 0.8 | Independent index; moderate bot detection at burst rates |
| `yahoo` | 0.8 | Distinct backend from Bing; low blocking rate |
| `qwant` | 0.7 | EU-based independent index; stable at low volume |
| `duckduckgo` | 0.6 | Intermittent IP blocks (upstream issue [#4824](https://github.com/searxng/searxng/issues/4824), open) |

Disabled engines:

- **StartPage** — broken at the SearXNG code level (missing `sgt` parameter, issue [#4549](https://github.com/searxng/searxng/issues/4549) open); will not recover until patched upstream
- **Google** — IP-blocks automated access within minutes regardless of configuration

If `BRAVE_SEARCH_API_KEY` is set, a `braveapi` engine is injected at weight 1.2. It uses Brave's official REST API, bypasses bot detection entirely, and is independent from the scraped `brave` engine. Brave's API is pay-as-you-go at $0.005/query with no free tier. Obtain a key at [brave.com/search/api](https://brave.com/search/api/).

The health check on startup requires at least one engine to return results. If all engines fail (e.g. a blocked network), set `PI_RESEARCH_SKIP_HEALTHCHECK=1` to bypass it.

---

## Terminal UI

The TUI updates in real time as researchers run. Each researcher gets a column showing its current token count and accumulated cost. Green flashes on successful tool calls, red on errors. The header shows overall progress as a percentage, or `[planning...]` during the coordinator phase.

**Quick mode** — single researcher:

```
── Research ──────────────────────────────────────────────
┌───────┬─────────────────────┐ 1 ┌──────────────────────┐
│SearXNG│                      8.3k                      │
│:55732 │                     $0.04                      │
└───────┴────────────────────────────────────────────────┘
```

**Deep mode** — three researchers mid-run:

```
── Research: 45% ─────────────────────────────────────────────────────
┌───────┬───────┐ 1 ┌────────┬───────┐ 2 ┌───────┬───────┐ 3 ┌───────┐
│SearXNG│        2.1k        │       1.8k        │        950        │
│:55732 │       $0.04        │       $0.03       │       $0.01       │
└───────┴────────────────────┴───────────────────┴───────────────────┘
```

**Lead evaluator promotion** — researcher 3 becomes the evaluator after all researchers complete. Completed researchers remain visible in muted color. The evaluator column shows no token/cost display:

```
── Research: 75% ─────────────────────────────────────────────────────
┌───────┬───────┐ 1 ┌────────┬───────┐ 2 ┌───────┬───────────────────┐
│SearXNG│        2.1k        │       1.8k        │        Eval        │
│:55732 │       $0.04        │       $0.03       │                    │
└───────┴────────────────────┴───────────────────┴────────────────────┘
```

When a new round is delegated, the progress bar expands ("exploring") and new researcher columns appear. Up to 6 researchers are shown at once; additional ones appear as a `+N` overflow indicator. The SearXNG box appears only in the bottom-most active research panel when multiple research runs stack in the same pi session.

---

## Architecture

### Entry point and tool registration

`index.ts` registers the `research` tool and three lifecycle hooks: `session_start` (checks Docker availability), `before_agent_start` (appends tool usage guidance to the system prompt), and `session_shutdown` (cleans up SearXNG). SearXNG initialization is deferred to the first actual research call.

### Quick mode

`src/tool.ts` routes `depth 0` directly to a single researcher session. The researcher has a fixed budget of 4 gathering calls (shared across search, security search, Stack Exchange, and grep) and 4 scrape calls. After exhausting those calls or receiving the query response, the researcher writes its findings and exits.

### Deep mode orchestration

For `depth 1–3`, the orchestrator in `src/orchestration/deep-research-orchestrator.ts` drives a state machine through four phases:

1. **Planning** — the AI coordinator reviews the conversation context and produces a JSON agenda: an exhaustive list of research tasks.
2. **Researching** — researchers run in parallel (max 3 concurrent). Each gets one agenda task plus injected findings from researchers that finished earlier in the same round.
3. **Evaluating** — the last researcher to finish a round is promoted to lead evaluator. It reviews all findings against the original agenda, then either synthesizes a final report (plain markdown) or delegates with a JSON object specifying new queries for the next round.
4. **Synthesizing** — the final synthesis is returned as the tool result.

State transitions are handled by a pure reducer (`deep-research-reducer.ts`) that is testable without mocks. State is persisted to pi's session tree so interrupted runs can resume. If a run is interrupted mid-round, running researchers are reset to pending on reload.

### Research tools and limits

Each researcher has access to five tools, enforced by `ToolUsageTracker`:

- **search** — web search via SearXNG; accepts multiple queries per call
- **scrape** — full-page content extraction; context-aware 4-call protocol (see below)
- **security_search** — NVD, CISA KEV, GitHub Advisories, OSV; filterable by severity, CVE ID, package, ecosystem, and actively-exploited status
- **stackexchange** — Stack Overflow and the SE network; search, get question/answer, filter by tags
- **grep** — local code search via `rg` with `grep` fallback

Gathering limit: 4 calls shared across search, security_search, stackexchange, and grep per researcher per round. Scrape has its own 4-call budget.

### Context-aware scraping

The scrape tool uses a four-call protocol designed to stay within context window limits:

- **Call 1 (handshake)** — researcher declares intended URLs; tool returns already-scraped links from the shared pool. No network activity.
- **Call 2 (batch 1)** — up to 3 URLs, broad primary scraping.
- **Call 3 (batch 2)** — up to 2 URLs, targeted follow-up; already-scraped links automatically excluded.
- **Call 4 (batch 3)** — up to 3 URLs, deep-dive scraping.

All batches are skipped automatically if the current token count exceeds 55% of the model's context window. Calls beyond the 4-call budget return a "Protocol Complete" message. This prevents context overflow in long multi-researcher sessions.

### Shared link deduplication

All researchers in a session share a global URL pool. When a researcher completes a scrape, those URLs are added to the pool. The handshake call returns the current pool so researchers avoid re-scraping pages a sibling already retrieved.

### SearXNG container lifecycle

`src/infrastructure/searxng-lifecycle.ts` manages a single SearXNG container for the entire pi process. The container is started on the first research call, reused for all subsequent calls, and cleaned up on `session_shutdown`. If `PROXY_URL` or `BRAVE_SEARCH_API_KEY` is set, a runtime settings YAML is generated and volume-mounted into the container instead of the default config.

Container details: image `searxng/searxng:latest`, container name `pi-searxng`, host port `55732`. Config files `config/default-settings.yml` and `config/limiter.toml` are mounted read-only.

State across multiple pi sessions sharing the same container is tracked in `~/.pi/state/searxng-singleton.json` with file-based locking, stale session detection, and backup-based corruption recovery.

### Lead evaluator decision framework

When promoted, the evaluator checks (in order):

1. Whether all researchers errored — if so, report the errors and stop.
2. Coverage: are all agenda items addressed in sufficient depth to answer the root query?
3. Round budget: if `current_round < target_rounds`, more capacity is available; if at or over budget, synthesize unless coverage is critical gaps.

If delegating, the evaluator returns `{"action": "delegate", "queries": [...]}`. If synthesizing, it returns markdown directly — any non-JSON response is treated as synthesis. Two bonus rounds beyond the target depth are allowed (`MAX_EXTRA_ROUNDS = 2`). At `targetRounds + 2`, delegation is refused in code and the orchestrator falls back to a concatenation of all researcher findings.

---

## Docker and SearXNG Details

| Setting | Value |
|---------|-------|
| Image | `searxng/searxng:latest` |
| Container name | `pi-searxng` |
| Host port | `55732` |
| Config mount | `config/default-settings.yml`, `config/limiter.toml` |
| Runtime config | `config/runtime-settings-{id}.yml` (proxy or Brave API key) |
| State file | `~/.pi/state/searxng-singleton.json` |

Useful commands:

```bash
docker info                              # confirm daemon access
docker ps --filter name=pi-searxng       # check container status
docker logs pi-searxng                   # view SearXNG logs
docker rmi searxng/searxng:latest        # force fresh pull on next start
```

---

## Project Structure

```text
pi-research/
├── index.ts                        # Extension entry point
├── src/
│   ├── tool.ts                     # Research tool: validation, SearXNG init, quick/deep routing
│   ├── config.ts                   # Config factory and env var parsing
│   ├── logger.ts                   # Diagnostic logging
│   ├── constants.ts                # Shared constants (flash duration, context limits, etc.)
│   ├── orchestration/
│   │   ├── deep-research-orchestrator.ts  # State machine: planning → research → evaluation
│   │   ├── deep-research-reducer.ts       # Pure state transitions (testable)
│   │   ├── deep-research-types.ts         # State schema and event types
│   │   ├── researcher.ts                  # Researcher session factory
│   │   ├── state-manager.ts               # Session tree persistence and recovery
│   │   └── id-utils.ts                    # Sibling ID → display number mapping
│   ├── infrastructure/
│   │   ├── searxng-lifecycle.ts           # SearXNG singleton: status, URL, functional check
│   │   ├── searxng-manager.ts             # Docker container management (dockerode)
│   │   └── state-manager.ts              # Cross-session singleton state with file locking
│   ├── tools/
│   │   ├── index.ts                       # Tool factory
│   │   ├── search.ts                      # SearXNG web search
│   │   ├── scrape.ts                      # Context-aware URL scraping
│   │   ├── security.ts                    # NVD / CISA KEV / GitHub Advisories / OSV
│   │   ├── stackexchange.ts               # Stack Exchange REST API
│   │   └── grep.ts                        # Local code search
│   ├── tui/
│   │   ├── research-panel.ts              # Panel rendering, flash animations, token display
│   │   └── searxng-status.ts             # SearXNG status component
│   ├── types/
│   │   ├── extension-context.ts           # Pi session and model interfaces
│   │   └── llm.ts                         # Token usage and content block types
│   └── utils/
│       ├── tool-usage-tracker.ts          # Per-researcher call limit enforcement
│       ├── session-state.ts               # Multi-run tracking within a Pi session
│       ├── shared-links.ts                # Cross-researcher URL deduplication
│       ├── research-export.ts             # Markdown report export
│       ├── shutdown-manager.ts            # Cleanup handler registry
│       ├── json-utils.ts                  # Robust JSON extraction from LLM output
│       ├── inject-date.ts                 # Date injection into prompts
│       ├── input-validation.ts            # Query sanitization
│       └── text-utils.ts                  # Text helpers
├── prompts/
│   ├── researcher.md                      # Three-phase research cycle instructions
│   ├── system-coordinator.md              # Agenda generation (one-shot)
│   └── system-lead-evaluator.md           # Synthesis vs. delegation decision framework
├── config/
│   ├── default-settings.yml               # SearXNG engine config and suspension times
│   └── limiter.toml                       # SearXNG rate limiter config
├── test/
│   ├── unit/                              # Unit tests (no Docker required)
│   └── integration/                       # Integration tests (require Docker and network)
├── configs/                               # Vitest and ESLint config files
├── scripts/
│   └── setup.js                           # Postinstall: Playwright browser setup
├── assets/                                # README images
├── .env.example                           # Environment variable reference
└── package.json
```

---

## Development

```bash
npm install            # install dependencies
npm run type-check     # TypeScript compiler check
npm run lint           # ESLint
npm run lint:fix       # auto-fix linting issues
npm run test:unit      # unit tests (no Docker required)
npm run test:integration  # integration tests (requires Docker and network)
npm run test:coverage  # coverage report
```

Integration tests may pull and start SearXNG containers. Start Docker before running them.

---

## Release

```bash
npm version patch      # or minor / major
git push origin main
git push origin v0.2.2
```

Publishing runs automatically via GitHub Actions when a version-matching tag (e.g. `v0.2.2`) is pushed. CI runs lint, type-check, and unit tests before publishing to npm as `@lincolndeen/pi-research` and creating a GitHub Release.

---

## Dependencies

Docker must be installed separately. npm dependencies install automatically.

| Package | Purpose |
|---------|---------|
| `playwright` | Chromium browser for JavaScript-heavy page scraping |
| `dockerode` | Docker API client for SearXNG container management |
| `js-yaml` | YAML parsing for SearXNG settings generation |
| `node-html-markdown` | HTML to Markdown conversion |
| `@kreuzberg/html-to-markdown-node` | Native HTML to Markdown (platform-specific binaries) |
