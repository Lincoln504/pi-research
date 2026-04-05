# pi-research

![pi-research banner](README-banner.jpg)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/pi-research.svg)](https://www.npmjs.com/package/pi-research)
[![CI Status](https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml/badge.svg)](https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml)

Multi-agent research orchestration extension for pi. Uses a coordinator to delegate parallel/sequential researcher agents, then synthesizes findings into comprehensive answers.

## Features

- Multi-agent orchestration with coordinator + parallel/sequential researchers
- Web search via SearXNG with Docker container management
- URL scraping with 2-layer architecture (fetch → Playwright fallback)
- Security vulnerability database search (NVD, CISA KEV, GitHub, OSV)
- Stack Exchange API integration for technical answers
- Code search using ripgrep (rg) with grep fallback
- Visual progress tracking with TUI panel
- Optional Tor and HTTP proxy support

## Installation

### From npm

```bash
npm install -g pi-research
```

### From GitHub

```bash
npm install -g https://github.com/Lincoln504/pi-research-dev.git
```

### Development

```bash
cd ~/Documents/pi-research
npm install
pi -e ./index.ts
```

## Usage

### Basic Research

```bash
pi
```

Then ask:

```
Please research: What is a binary search tree?
```

### Programmatic Usage

```python
research("history of the internet")
```

### Configuration

Copy the example configuration file:

```bash
cp .env.example .env
```

Edit `.env` to set options:

```bash
# Proxy URL (optional)
PROXY_URL=socks5://127.0.0.1:9050

# Researcher timeout (default: 240000ms / 4 minutes)
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=240000

# TUI mode (simple or full)
PI_RESEARCH_TUI_MODE=simple
```

Source the configuration:

```bash
source .env
pi
```

## Architecture

```
Query → Coordinator → Researchers (search, scrape, security_search, stackexchange, rg_grep)
                        ↓
                   Synthesis
                        ↓
                   Final Answer
```

## Components

- `src/tool.ts`: Main orchestration and research tool
- `src/orchestration/coordinator.ts`: Coordinator session management
- `src/orchestration/researcher.ts`: Researcher session management
- `src/agent-tools.ts`: Agent tool factories
- `src/tools/search.ts`: Web search via SearXNG
- `src/tools/scrape.ts`: URL scraping
- `src/tools/security.ts`: Security vulnerability database search
- `src/tools/stackexchange.ts`: Stack Exchange API
- `src/tools/grep.ts`: Code search (rg_grep)
- `src/web-research/`: Web search and scraping utilities
- `src/security/`: Security database clients
- `src/stackexchange/`: Stack Exchange client and caching
- `src/searxng-lifecycle.ts`: SearXNG Docker container management
- `src/tui/`: Visual progress tracking widgets

## Research Process

1. User submits query
2. Coordinator receives context + query
3. SearXNG container starts (if not running)
4. TUI panel displays progress
5. Coordinator assesses complexity and delegates to researchers
6. Researchers investigate using available tools
7. Coordinator reviews findings, may delegate follow-up research
8. Final answer synthesized and returned

## Available Tools

### Researchers have access to:

- `search`: Web search via SearXNG
- `scrape`: URL scraping with 2-layer architecture
- `security_search`: Security vulnerability database search
- `stackexchange`: Stack Exchange API search
- `rg_grep`: Code search using ripgrep/grep
- `read`: Read project files

### Coordinator has access to:

- `delegate_research`: Spawn researcher agents
- `investigate_context`: Inspect local project (read + grep only)
- `rg_grep`: Code search

## TUI Modes

### Simple Mode (default)

```
┌─ Research Panel ─────────────────────────┐
│ ● active  http://localhost:8080  tk: 10.2k │
│ ● Coordinator  ●1 ●2 ●3              │
└────────────────────────────────────────────┘
```

### Full Mode

```
┌─ Research Coordinator ── tk: 42.3k ──────┐
│    1         2         3                │
│   ●●        ●●        ●●               │
│   ○1.1      ○         ○                │
│   ○1.2      ○         ○                │
└───────────────────────────────────────────┘
```

Set TUI mode via environment variable:

```bash
export PI_RESEARCH_TUI_MODE=simple|full
```

## Configuration Options

```bash
# Researcher timeout (default: 240000ms / 4 minutes)
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=240000

# Flash duration for TUI (default: 1000ms)
PI_RESEARCH_FLASH_TIMEOUT_MS=1000

# Proxy URL (optional)
PROXY_URL=socks5://127.0.0.1:9050

# TUI mode (default: simple)
PI_RESEARCH_TUI_MODE=simple
```

## Proxy Support

For Tor or HTTP proxy support, configure in `.env`:

```bash
# Tor
PROXY_URL=socks5://127.0.0.1:9050

# HTTP proxy
PROXY_URL=http://proxy.example.com:8080

# Authenticated proxy
PROXY_URL=http://user:pass@proxy.example.com:8080
```

See `TOR.md` for detailed Tor setup instructions.

## Dependencies

- `@mariozechner/pi-coding-agent`: pi core SDK
- `@sinclair/typebox`: Parameter schema validation
- `@kreuzberg/html-to-markdown-node`: HTML to Markdown conversion
- `dockerode`: Docker API client
- `js-yaml`: YAML parsing
- `playwright`: Headless browser for JS-heavy scraping

## Development

```bash
cd ~/Documents/pi-research

# Install dependencies
npm install

# Type checking
npx tsc --noEmit

# Linting
npm run lint
```

## License

MIT
