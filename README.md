![pi-research banner](README-banner.jpg)

[![npm version](https://img.shields.io/npm/v/pi-research.svg)](https://www.npmjs.com/package/pi-research)

Opinionated web research extension for pi coding agent. Provides a set of web research tools and a restricted subagent system which utilizes them to do either quick (single agent) or deep (multi-agent) research.

### Capabilities

- **Single-agent research** (`quick: true`): Fast, focused queries with one researcher
- **Multi-agent research** (default): Coordinator orchestrates parallel/sequential researchers
- **Web search**: SearXNG integration via Docker container
- **URL scraping**: Two-layer architecture (fetch → Playwright fallback for JavaScript-heavy pages)
- **Security database queries**: NVD, CISA KEV, GitHub Advisories, OSV
- **Stack Exchange API**: Integration with Stack Overflow and Stack Exchange network
- **Code search**: ripgrep (rg) with grep fallback for local codebase queries
- **Terminal UI**: Progress tracking panel showing SearXNG status and active research slices
- **Proxy support**: (optional, for avoiding search engine rate limits, configure via environment)

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

### Usage

#### Via pi agent

Once extension is loaded, ask pi agent to research a topic:
```text
Please research "What is a binary search tree?"
```

#### Via tool invocation

Invoke research tool directly:
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

1. **Extension entry point** (`index.ts`): Registers `research` tool with pi
2. **Tool orchestration** (`src/tool.ts`): Main entry point for research calls, initializes SearXNG, manages TUI
3. **Coordinator** (`src/orchestration/coordinator.ts`): Decomposes queries into slices, delegates to researchers, synthesizes findings
4. **Delegate tool** (`src/orchestration/delegate-tool.ts`): Spawns researcher agents
5. **Researcher** (`src/orchestration/researcher.ts`): Research agent session management
6. **SearXNG lifecycle** (`src/infrastructure/searxng-lifecycle.ts`): Docker container management for SearXNG
7. **State management** (`src/infrastructure/state-manager.ts`): Tracks sessions, token usage, failures
8. **Tools**:
   - `search.ts`: Web search via SearXNG
   - `scrape.ts`: URL scraping with retry logic
   - `security.ts`: Security database queries (NVD, CISA, GitHub, OSV)
   - `stackexchange.ts`: Stack Exchange API queries
   - `grep.ts`: Local code search
9. **Web research** (`src/web-research/`): Search, scraping, retry utilities
10. **Security** (`src/security/`): Security database integrations
11. **Stack Exchange** (`src/stackexchange/`): API client, caching, output formatting
12. **TUI** (`src/tui/`): Terminal UI panel for progress tracking
13. **Utils**: Shared utilities (text formatting, session state, shared links)
14. **Prompts**: System prompts for coordinator and researcher agents

#### Research workflow

1. **Coordinator receives query**: Assesses complexity level (Level 1/2/3 based on query)
2. **Delegate research**: Coordinator decomposes query into slices and spawns researcher agents
3. **Researcher cycles**:
   - Phase 1: 6 rounds of gathering (search, security_search, stackexchange, grep)
   - Phase 2: Single batch scrape of 5-10 links
   - Phase 3: Report findings with CITED LINKS and SCRAPE CANDIDATES
4. **Shared link pool**: Automatic coordination via pool of scraped links
5. **Synthesis**: Coordinator combines slice findings into final answer

#### Research levels

- **Level 0 (Quick)**: No coordinator, single researcher session. (Activated by using the `quick` parameter).
- **Level 1 (Brief)**: 1 slice, up to 1 follow-up. Default for simple factual queries.
- **Level 2 (Normal)**: 2-3 slices, up to 2 follow-ups. For technical/multi-faceted topics.
- **Level 3 (Deep)**: 4-5 slices, 3-4 follow-ups. For complex cross-domain analysis.

#### SearXNG management

Managed as singleton Docker container:
- Initialized on first `research()` call (lazy initialization)
- Lives for duration of pi process
- Shared across agents in all sessions
- Health checks and automatic restart on failure

#### Shared link pool

Researchers report links in two categories:
- **CITED LINKS**: URLs scraped and used in findings
- **SCRAPE CANDIDATES**: URLs found but not scraped

Pool is automatically:
- Built from researcher responses
- Injected into subsequent researchers' context
- Used to avoid duplicate scraping

### Configuration

Environment variables can be configured in a `.env` file in the project root.

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | - | Proxy URL for SearXNG (optional, e.g., `socks5://127.0.0.1:9050`). |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | 240000 | Per-researcher timeout in milliseconds (30s-10m). |
| `PI_RESEARCH_FLASH_TIMEOUT_MS` | 1000 | TUI flash indicator duration in milliseconds. |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | 15000 | SearXNG health check timeout in milliseconds. |
| `STACKEXCHANGE_API_KEY` | - | Optional API key for higher Stack Exchange rate limits. |

#### Logging & Verbose Mode

When verbose mode is enabled (via `pi --verbose`), the extension writes timestamped logs to `/tmp/pi-research-debug-{hash}.log`, where `{hash}` is a unique 4-character suffix per run. If verbose mode is not enabled, no log files are created.

### Terminal UI

Displays dedicated TUI panel to track progress in real-time.

#### Components

1. **SearXNG Status** (Left box):
   - **Service Name**: Shows `SearXNG`, `Offline`, or `Error`.
   - **Port**: Displays local port (e.g., `:55732`).
   - **Connections**: Shows active concurrent search connections.

2. **Research Progress** (Right box):
   - **Header**: Displays active model (e.g., `qwen/qwen3.5-35b-a3b`) and cumulative token usage.
   - **Slices**: Vertical columns representing research "slices" or agents.
   - **Status Indicators**: 
     - `1:1`, `2:1`: Active/Running.
     - `✓1:1`: Completed successfully.
     - **Flash effects**: Slices flash **green** on successful tool calls and **red** on errors.

#### Modes

- **Deep Mode** (Default): Shows multiple slice columns as coordinator delegates work to parallel researchers.
- **Quick Mode**: Shows exactly one research slice box for single researcher.

#### Layout Example

```text
┌───────┐ ┌─ Research | qwen/qwen3.5-35b-a3b  40.5k ┬─────────────────────┐
│SearXNG│ │                    │                    │                     │
│:55732 │ │        ✓1:1        │        ✓2:1        │          3:1        │
│1      │ │                    │                    │                     │
└───────┘ └────────────────────┴────────────────────┴─────────────────────┘
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

- `@mariozechner/pi-coding-agent`: pi core SDK
- `@sinclair/typebox`: Parameter schema validation
- `@kreuzberg/html-to-markdown-node`: HTML to Markdown conversion
- `dockerode`: Docker API client for container management
- `js-yaml`: YAML parsing for SearXNG settings
- `playwright`: Headless browser for JS-heavy web scraping
- `Native fetch`: Built-in Node.js fetch for HTTP requests

### License

MIT
