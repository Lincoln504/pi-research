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

Install as a pi package:
```bash
npm install pi-research
```

Or load directly from source:
```bash
git clone https://github.com/Lincoln504/pi-research.git
cd pi-research
npm install
pi -e ./index.ts
```

Requires Docker to be installed.

### Usage

Once installed, ask for research. The model will use the research tool naturally:

```text
Research "What is a binary search tree?"
```

The research tool supports parameters: `query` (required, the research topic), `quick` (boolean, defaults to false for multi-agent coordination), and `model` (optional, defaults to active model).

### Architecture

Entry point (`index.ts`) registers the research tool. The tool orchestration layer (`src/tool.ts`) initializes SearXNG, manages the TUI, and branches between quick and deep modes.

In deep mode, a coordinator agent (`src/orchestration/coordinator.ts`) decomposes the query into research aspects and spawns parallel researcher agents via the delegate tool (`src/orchestration/delegate-tool.ts`). Researchers (`src/orchestration/researcher.ts`) cycle through three phases: gathering (6 rounds max via search, security_search, stackexchange, grep), batch scraping (5-10 URLs), and reporting findings with cited links and scrape candidates. A shared link pool coordinates across researchers to avoid duplicate scraping.

In quick mode, a single researcher session runs without a coordinator, returning results directly.

SearXNG manages a singleton Docker container (`src/infrastructure/searxng-lifecycle.ts`) that's lazily initialized on first call and lives for the pi process duration. Tools include search (web via SearXNG), scrape (with retry and JS rendering), security (NVD, CISA KEV, GitHub, OSV), stackexchange (Stack Exchange API), and grep (local code search). Web research utilities handle searching, scraping, and retries; security utilities integrate multiple databases; Stack Exchange utilities handle API access and caching.

Complexity assessment determines researcher count:

- Level 1 (Brief) — 1–2 researchers. Default for simple factual queries.
- Level 2 (Normal) — 2–3 researchers. For technical/multi-faceted topics.
- Level 3 (Deep) — 3–5 researchers. For complex cross-domain analysis.

### Configuration

Set environment variables in `.env` file (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | - | Proxy URL for SearXNG (optional, e.g., `socks5://127.0.0.1:9050`). |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | 240000 | Per-researcher timeout in milliseconds (30s-10m). |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | 15000 | SearXNG health check timeout in milliseconds. |
| `DOCKER_SOCKET` | /var/run/docker.sock | Docker socket path for container management. |
| `STACKEXCHANGE_API_KEY` | - | Optional API key for higher Stack Exchange rate limits. |

Enable verbose logging with `pi --verbose`. Logs are written to `/tmp/pi-research-debug-{hash}.log` (where `{hash}` is a unique 4-character suffix per run). Without verbose mode, no log files are created.

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
│   ├── orchestration/
│   │   ├── coordinator.ts   # Coordinator agent session
│   │   ├── delegate-tool.ts # Delegate tool implementation
│   │   ├── researcher.ts    # Researcher agent session
│   │   ├── context-tool.ts  # Context inspection tool
│   │   └── session-context.ts # Session context utilities
│   ├── infrastructure/
│   │   ├── state-manager.ts # Session/state management
│   │   ├── searxng-manager.ts # SearXNG container manager
│   │   └── searxng-lifecycle.ts # SearXNG lifecycle management
│   ├── tools/
│   │   ├── search.ts        # Web search tool
│   │   ├── scrape.ts        # URL scraping tool
│   │   ├── security.ts      # Security database tool
│   │   ├── stackexchange.ts # Stack Exchange tool
│   │   └── grep.ts          # Code search tool
│   ├── web-research/        # Search/scraping utilities
│   ├── security/            # Security database integrations
│   ├── stackexchange/       # Stack Exchange API integration
│   ├── tui/                 # Terminal UI components
│   └── utils/               # Shared utilities
├── prompts/
│   ├── coordinator.md       # Coordinator system prompt
│   └── researcher.md        # Researcher system prompt
├── test/                    # Test suite
├── .env.example             # Example configuration
├── package.json             # Package metadata
└── README.md                # This file
```

### Development

```bash
cd pi-research

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
