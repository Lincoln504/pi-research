![pi-research banner](assets/README-banner.jpg)

[![npm version](https://img.shields.io/npm/v/pi-research.svg)](https://www.npmjs.com/package/pi-research)

Multi-agent web research for pi. Coordinate parallel researchers or run a single sub-agent on a query. Search the web, scrape URLs, query security databases, access Stack Exchange, search code, and track progress via terminal UI. Search multiple providers (Google, Bing, Brave, and others) with no cost thanks to [SearXNG](https://github.com/searxng/searxng). 

### Capabilities

- Single-agent research (`quick: true`) — Fast, focused queries with one researcher
- Multi-agent research (default) — Coordinator orchestrates parallel researchers
- Web search — SearXNG via Docker container
- URL scraping — Two-layer architecture (fetch → Playwright for JavaScript-heavy pages)
- Security databases — NVD, CISA KEV, GitHub Advisories, OSV
- Stack Exchange — Query Stack Overflow and Stack Exchange network
- Code search — ripgrep (rg) with grep fallback for local queries
- Terminal UI — Real-time progress tracking with SearXNG status and researcher progress
- Proxy support — Optional proxy configuration to avoid rate limits

### Installation

Requirements:

- Node.js `22.13.0` or any supported `24.x+` release (`.nvmrc` pins `22.13.0`)
- `pi` CLI installed on your machine
- Docker installed and running for SearXNG-backed web search

Setup:

```bash
# Use the pinned Node version
nvm use

# Install dependencies
npm install

# Optional: create local config file
cp .env.example .env
```

Install into `pi` from this repo:

```bash
pi install .
```

Or load it directly for a single session:

```bash
pi -e ./index.ts
```

### Usage

Once installed, ask for research. The model will use the research tool naturally:

```text
Research "What is a binary search tree?"
```

The research tool supports parameters: `query` (required, the research topic), `quick` (boolean, defaults to false for multi-agent coordination), and `model` (optional, defaults to active model).

### Architecture

**Entry Point & Orchestration**
- Entry point (`index.ts`) registers the research tool
- Tool orchestration layer (`src/tool.ts`) initializes SearXNG, manages the TUI, and branches between quick and deep modes

**Deep Mode (Multi-Agent)**
- Planning Phase: Swarm Orchestrator (`src/orchestration/swarm-orchestrator.ts`) uses an AI coordinator to decompose the query into a research agenda.
- Execution Phase: Spawns parallel researcher agents.
- Researchers (`src/orchestration/researcher.ts`) cycle through three phases:
  - Gathering (4 calls max via search, security_search, stackexchange, grep)
  - Batch scraping (Two-step protocol: handshake then execution)
  - Reporting findings with cited links and scrape candidates
- Lead Evaluation: The last researcher in a round is promoted to Lead Evaluator to decide whether to synthesize the final report or delegate another round of research.
- Shared link pool coordinates across researchers to avoid duplicate scraping.

**Quick Mode (Single-Agent)**
- Single researcher session runs without a coordinator
- Returns results directly

**SearXNG Container Management**
- Singleton Docker container (`src/infrastructure/searxng-lifecycle.ts`)
- Lazily initialized on first call
- Lives for the pi process duration

**Available Tools**
- Search — Web via SearXNG
- Scrape — With retry and JS rendering
- Security — NVD, CISA KEV, GitHub, OSV
- Stack Exchange — Stack Exchange API
- Grep — Local code search

Complexity assessment determines researcher count:

- Level 1 (Brief) — 1–2 researchers. Default for simple factual queries.
- Level 2 (Normal) — 2–3 researchers. For technical/multi-faceted topics.
- Level 3 (Deep) — 3–5 researchers. For complex cross-domain analysis.

### Configuration

Set environment variables in `.env` file (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | - | Proxy URL for SearXNG (optional, e.g., `socks5://127.0.0.1:9050`; host loopback is mapped to Docker's portable `host.docker.internal` alias inside the container). |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | 240000 | Per-researcher timeout in milliseconds (30s-10m). |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | 15000 | SearXNG health check timeout in milliseconds. |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | 10 | Global TUI refresh debounce in milliseconds. |
| `DOCKER_SOCKET` | platform default | Optional Docker socket override. Defaults are platform-specific: Unix socket on Linux/macOS, Docker named pipes on Windows. |
| `STACKEXCHANGE_API_KEY` | - | Optional API key for higher Stack Exchange rate limits. |

Enable verbose diagnostics with `pi --verbose` or `PI_RESEARCH_VERBOSE=1`. Logs are written as JSONL to your OS temp directory as `pi-research-debug-{hash}.log` (where `{hash}` is a unique 4-character suffix per process). Without verbose mode, no log files are created. Normal TUI, JSON/RPC, and headless runs do not receive diagnostic chatter on stdout or stderr. Entries from research runs include scoped fields such as Pi session id, session file, cwd, research run id, tool name, level, timestamp, message, and error stack when available.

### Terminal UI

Real-time progress tracking with two panels. The left panel shows SearXNG status (status, port, active connections). The right panel shows research progress with the active model, cumulative token usage, researcher columns (numbered 1, 2, 3...), completion status (`✓1`, `✓2`), and tool results (flashing green on success, red on error).

```text
┌───────┐ ┌─ Research | qwen/qwen3.5-35b-a3b  40.5k ──┐
│SearXNG│ │           │           │             │
│:55732 │ │    ✓1     │    ✓2     │      3      │
│1      │ │           │           │             │
└───────┘ └───────────┴───────────┴─────────────┘
```

### Project structure

```
pi-research/
├── index.ts                 # Extension entry point
├── src/
│   ├── tool.ts              # Research tool orchestration
│   ├── config.ts            # Configuration management
│   ├── logger.ts            # Logging utilities
├── orchestration/
│   ├── swarm-orchestrator.ts # Main swarm lifecycle manager
│   ├── swarm-reducer.ts    # Pure state transition logic
│   ├── swarm-types.ts      # Research state schemas
│   ├── researcher.ts       # Researcher agent session
│   ├── state-manager.ts    # Session state persistence
│   ├── id-utils.ts         # Hierarchical ID to display mapping
│   └── session-context.ts  # Parent context utilities
├── infrastructure/
│   ├── searxng-manager.ts # SearXNG container manager
│   └── searxng-lifecycle.ts # SearXNG lifecycle management
├── tools/
│   ├── search.ts        # Web search tool
│   ├── scrape.ts        # URL scraping tool
│   ├── security.ts      # Security database tool
│   ├── stackexchange.ts # Stack Exchange tool
│   └── grep.ts          # Code search tool
├── web-research/        # Search/scraping utilities
├── security/            # Security database integrations
├── stackexchange/       # Stack Exchange API integration
├── tui/                 # Terminal UI components
└── utils/               # Shared utilities
├── prompts/
│   ├── system-coordinator.md # Planning prompt
│   ├── researcher.md         # Researcher workflow prompt
│   └── system-lead-evaluator.md # Final synthesis/orchestration prompt
├── test/                    # Test suite
├── .env.example             # Example configuration
├── package.json             # Package metadata
└── README.md                # This file
```

### Development

```bash
# Install dependencies
npm install

# Type checking
npx tsc --noEmit

# Linting
npm run lint

# Run tests
npm test
```

### Dependencies

All dependencies (except Docker) are installed with the extension.

- `@mariozechner/pi-coding-agent` — pi core SDK
- `@sinclair/typebox` — Parameter schema validation
- `@kreuzberg/html-to-markdown-node` — HTML to Markdown conversion
- `js-yaml` — YAML parsing for SearXNG settings
- `playwright` — Headless browser for JS-heavy web scraping
- `chromium` — Browser engine for Playwright (auto-installed)
- `dockerode` — Docker API client for container management (requires Docker installed separately)
- Native fetch — Built-in Node.js fetch for HTTP requests

### License

MIT
