![pi-research banner](assets/README-banner.jpg)

[![npm version](https://img.shields.io/npm/v/@lincolndeen/pi-research.svg)](https://www.npmjs.com/package/@lincolndeen/pi-research)

Multi-agent web research extension for [pi](https://github.com/mariozechner/pi). Runs parallel AI researchers against a self-hosted SearXNG search container, scrapes pages, queries security databases, and tracks everything in a real-time terminal UI.

---

## Contents

- [Capabilities](#capabilities)
- [Requirements](#requirements)
- [Install](#install)
- [Platform Setup](#platform-setup)
- [Usage](#usage)
- [Research Depth](#research-depth)
- [Configuration](#configuration)
- [Development & Release](#development--release)
- [Architecture & Design](ARCHITECTURE.md)

---

## Capabilities

- **Multi-agent deep research** — AI coordinator decomposes a query into parallel research tracks; an AI lead evaluator synthesizes or delegates further rounds
- **Quick mode** — single researcher for fast, focused queries with no coordinator overhead
- **Web search** — SearXNG running in Docker, aggregating Bing, Brave, Yahoo, Qwant, and DuckDuckGo
- **URL scraping** — fetch-first with Playwright/Chromium fallback for JavaScript-heavy pages
- **Security databases** — NVD, CISA KEV, GitHub Advisories, OSV
- **Stack Exchange** — full network search and filtering
- **Real-time TUI** — per-researcher token and cost tracking

---

## Requirements

- Node.js `22.13.0` or any `24.x+` release
- The `pi` CLI installed and configured
- Docker daemon running (required for SearXNG)
- Internet access

---

## Install

```bash
pi install npm:@lincolndeen/pi-research
```

**From a checkout**

```bash
npm install
pi install .
```

---

## Platform Setup

**macOS/Linux** — Install and start Docker. Ensure your user is in the `docker` group on Linux.
**Windows** — Install Docker Desktop (Linux containers). Detecting named pipes is automatic.

---

## Usage

Ask pi for web research. The extension registers a `research` tool.

```text
Research "What is a binary search tree?"
Do a deep dive on CVE-2024-3094 at depth 2
```

| Depth | Mode | Researchers | Target rounds |
|-------|------|-------------|---------------|
| 0 (default) | Quick | 1 | 1 |
| 1 | Normal | 2 | 2 |
| 2 | Deep | 3 | 3 |
| 3 | Ultra | 5 | 5 |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAVE_SEARCH_API_KEY` | — | Enables `braveapi` engine (official REST API) |
| `PI_RESEARCH_VERBOSE` | — | Write diagnostic logs to temp directory |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | — | Skip startup health check |
| `PROXY_URL` | — | Proxy for SearXNG outgoing requests |

---

## Development & Release

**Commands**
- `npm run lint` / `npm run lint:fix`: Code quality
- `npm run type-check`: TypeScript verification
- `npm run test:unit`: Unit tests (no Docker required)
- `npm run test:integration`: Full tests (requires Docker)

**Release**
1. `npm version patch` (or minor/major)
2. `git push origin main --tags`
The GitHub Action will automatically publish to npm and create a release.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design information.
