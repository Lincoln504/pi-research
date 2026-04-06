![pi-research banner](assets/README-banner.jpg)

[![npm version](https://img.shields.io/npm/v/pi-research.svg)](https://www.npmjs.com/package/pi-research)

Multi-agent web research for pi. Coordinate parallel researchers or run a single sub-agent on a query. Search the web, scrape URLs, query security databases, access Stack Exchange, search code, and track progress via terminal UI. Search multiple providers (Google, Bing, Brave, and others) with no cost thanks to [SearXNG](https://github.com/searxng/searxng). 

### Capabilities

- **Single-agent research** (`quick: true`) — Fast, focused queries with one researcher
- **Multi-agent research** (default) — Coordinator orchestrates parallel researchers
- **Web search** — SearXNG via Docker container
- **URL scraping** — Two-layer architecture (fetch → Playwright for JavaScript-heavy pages)
- **Security databases** — NVD, CISA KEV, GitHub Advisories, OSV
- **Stack Exchange** — Query Stack Overflow and Stack Exchange network
- **Code search** — ripgrep (rg) with grep fallback for local queries
- **Terminal UI** — Real-time progress tracking with SearXNG status and research slices
- **Proxy support** — Optional proxy configuration to avoid rate limits

### Installation

#### From npm
```bash
npm install -g pi-research
```

#### From source
```bash
git clone https://github.com/Lincoln504/pi-research.git
cd pi-research
npm install
pi -e ./index.ts
```

**Note:** Requires Docker to be installed.

### Usage

#### Via pi agent

Ask pi to research a topic:
```text
Please research "What is a binary search tree?"
```

#### Via CLI

Run research directly:
```bash
pi research "What is a binary search tree?" --quick
```

#### Parameters

| Parameter | Type    | Default | Description                                             |
|-----------|---------|---------|---------------------------------------------------------|
| `query`   | string  | required| Research query or topic to investigate                  |
| `quick`   | boolean | false   | Enable quick mode: single researcher session (Level 0)  |
| `model`   | string  | -       | Model ID for research agents (defaults to active model) |

### Architecture

#### Layers

1. **Extension entry point** (`index.ts`) — Register `research` tool
2. **Tool orchestration** (`src/tool.ts`) — Main entry point, initialize SearXNG, manage TUI
3. **Coordinator** (`src/orchestration/coordinator.ts`) — Decompose queries, delegate to researchers, synthesize findings
4. **Delegate tool** (`src/orchestration/delegate-tool.ts`) — Spawn researcher agents
5. **Researcher** (`src/orchestration/researcher.ts`) — Manage researcher agent sessions
6. **SearXNG lifecycle** (`src/infrastructure/searxng-lifecycle.ts`) — Manage Docker container
7. **State management** (`src/infrastructure/state-manager.ts`) — Track sessions, token usage, failures
8. **Tools**:
   - `search.ts` — Web search via SearXNG
   - `scrape.ts` — URL scraping with retry logic
   - `security.ts` — Query NVD, CISA KEV, GitHub, OSV
   - `stackexchange.ts` — Query Stack Exchange API
   - `grep.ts` — Local code search
9. **Web research** (`src/web-research/`) — Search, scraping, retry utilities
10. **Security** (`src/security/`) — Security database integrations
11. **Stack Exchange** (`src/stackexchange/`) — API client, caching, formatting
12. **TUI** (`src/tui/`) — Terminal UI for progress tracking
13. **Utils** — Shared utilities (text, session state, link pools)
14. **Prompts** — System prompts for coordinator and researchers

#### Research workflow

1. Assess query complexity (Level 1/2/3)
2. Decompose query into slices and spawn researcher agents
3. Researchers cycle through phases:
   - Phase 1: 6 rounds or less of gathering (search, security_search, stackexchange, grep)
   - Phase 2: Batch scrape 5-10 links
   - Phase 3: Report findings with CITED LINKS and SCRAPE CANDIDATES
4. Coordinate via shared link pool to avoid duplicate scraping
5. Synthesize slice findings into final answer

#### Research levels

- **Level 0 (Quick)**: No coordinator, single researcher session. (Activated by using the `quick` parameter).
- **Level 1 (Brief)**: 1–2 researchers. Default for simple factual queries.
- **Level 2 (Normal)**: 2–3 researchers. For technical/multi-faceted topics.
- **Level 3 (Deep)**: 3–5 researchers. For complex cross-domain analysis.

#### SearXNG management

Singleton Docker container:
- Lazily initialized on first `research()` call
- Lives for duration of pi process
- Shared across all agents and sessions
- Automatic health checks and restart on failure

### Configuration

Set environment variables in `.env` file (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | - | Proxy URL for SearXNG (optional, e.g., `socks5://127.0.0.1:9050`). |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | 240000 | Per-researcher timeout in milliseconds (30s-10m). |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | 15000 | SearXNG health check timeout in milliseconds. |
| `DOCKER_SOCKET` | /var/run/docker.sock | Docker socket path for container management. |
| `STACKEXCHANGE_API_KEY` | - | Optional API key for higher Stack Exchange rate limits. |

#### Logging & Verbose Mode

Enable verbose logging with `pi --verbose`. Writes timestamped logs to `/tmp/pi-research-debug-{hash}.log` (where `{hash}` is a unique 4-character suffix per run). Without verbose mode, no log files are created.

### Terminal UI

Real-time progress tracking with two panels.

#### Components

1. **SearXNG Status** (Left):
   - Status: `SearXNG`, `Offline`, or `Error`
   - Port: Local port (e.g., `:55732`)
   - Connections: Active concurrent search connections

2. **Research Progress** (Right):
   - Header: Active model and cumulative token usage
   - Researchers: Vertical columns per researcher agent
   - Status:
     - `1`, `2` = Active/Running
     - `✓1` = Completed
     - Flash **green** on tool success, **red** on tool error

```text
┌───────┐ ┌─ Research | qwen/qwen3.5-35b-a3b  40.5k ──┐
│SearXNG│ │           │           │             │
│:55732 │ │    ✓1     │    ✓2     │      3      │
│1      │ │           │           │             │
└───────┘ └───────────┴───────────┴─────────────┘
```

#### Modes

- **Deep Mode** (Default) — Multiple slices and iterations for parallel research. Coordinator agent returns consolidated report.
- **Quick Mode** — Single research pass results returned.

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
│       └── make-resource-loader.ts # Resource loader factory
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

- `@mariozechner/pi-coding-agent`: pi core SDK
- `@sinclair/typebox`: Parameter schema validation
- `@kreuzberg/html-to-markdown-node`: HTML to Markdown conversion
- `js-yaml`: YAML parsing for SearXNG settings
- `playwright`: Headless browser for JS-heavy web scraping
- `chromium`: Browser engine for Playwright (auto-installed)
- `dockerode`: Docker API client for container management (requires Docker installed separately)
- `Native fetch`: Built-in Node.js fetch for HTTP requests

### License

MIT
