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
- [Architecture & Design](ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

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

**From a checkout**

```bash
nvm use                  # optional
npm install
pi install .
```

---

## Platform Setup

**macOS** — Install Docker Desktop and start the daemon.
**Linux** — Install Docker Engine/Desktop and start the daemon (`sudo systemctl start docker`). Ensure your user is in the `docker` group.
**Windows** — Install Docker Desktop (Linux containers). Detecting named pipes is automatic.

---

## Usage

Ask pi for web research. The extension registers a `research` tool.

```text
Research "What is a binary search tree?"
Research the latest Node.js 22 release notes
Do a deep dive on CVE-2024-3094 at depth 2
```

---

## Research Depth

| Depth | Mode | Researchers | Target rounds | When to use |
|-------|------|-------------|---------------|-------------|
| 0 (default) | Quick | 1 | 1 | Focused questions, fast lookups |
| 1 | Normal | 2 | 2 | Technical topics, moderate breadth |
| 2 | Deep | 3 | 3 | Multi-faceted analysis, security research |
| 3 | Ultra | 5 | 5 | Exhaustive investigation |

**Quick mode** runs a single researcher with a fixed budget of 4 gathering calls and 4 scrape calls.
**Deep mode** adds an AI coordinator for planning and a lead evaluator for synthesis/delegation across multiple parallel rounds.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAVE_SEARCH_API_KEY` | — | Enables `braveapi` engine (official REST API) |
| `PI_RESEARCH_VERBOSE` | — | Write diagnostic logs to temp directory |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | — | Skip startup health check |
| `PROXY_URL` | — | Proxy for SearXNG outgoing requests |
| `STACKEXCHANGE_API_KEY` | — | Stack Exchange API key for higher rate limits |

---

## Search Engines

Active by default: `bing` (priority), `brave`, `yahoo`, `qwant`, `duckduckgo`.
Disabled: `google` (IP-blocks) and `startpage` (broken upstream).

---

## Terminal UI

The TUI updates in real time. Each researcher shows current token usage and accumulated cost.
- **Green flash**: Successful tool call
- **Red flash**: Tool error
- **Muted color**: Researcher completed its task
- **Eval**: Researcher promoted to lead evaluator

---

## Docker and SearXNG Details

| Setting | Value |
|---------|-------|
| Image | `searxng/searxng:latest` |
| Container name | `pi-searxng` |
| Host port | `55732` |
| State file | `~/.pi/state/searxng-singleton.json` |

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design information.
