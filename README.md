![pi-research banner](docs/assets/README-banner.jpg)

<a href="https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Lincoln504/pi-research/ci.yml?style=flat-square&branch=main" /></a> <a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a>

Multi-agent web research extension for [pi](https://github.com/badlogic/pi-mono). Runs parallel AI researchers against a self-hosted SearXNG search container, scrapes pages, queries security databases, and tracks everything in a real-time terminal UI.

There are other ways to connect a `pi` session to the internet. Here is why this one is designed the way it is:

- **SearXNG-based** — free, no API keys required by default. A single Docker container is shared across all concurrent research calls on the same machine; no duplicate instances, no per-session overhead. Point `SEARXNG_URL` at an existing instance to skip container management entirely.
- **Unified subagent system** — web access, scraping, and synthesis are handled by isolated researcher agents. Research context stays out of the main chat session while still enabling thorough multi-source exploration.
- **Safety** — researcher agents have no access to file writes, file edits, or shell commands. All web tools are scoped to the subagent system and executed in a structured, tool-limited sequence to keep agents focused and prevent runaway use.
- **Minimal integration** — a system prompt hook provides light guidance to the host LLM on when and how to invoke the tool. No manual prompt engineering required. The extension does not conflict with other subagent or tool systems, and the unified toolset means no need to wire up multiple separate tools.

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
- [Architecture & Design](docs/ARCHITECTURE.md)

---

## Capabilities

- **Multi-agent deep research** — AI coordinator decomposes a query into parallel research tracks; an AI lead evaluator synthesizes or delegates further rounds
- **Quick mode** — single researcher for fast, focused queries with no coordinator overhead
- **Web search** — SearXNG running in Docker, aggregating Bing, Brave, Yahoo, Qwant, DuckDuckGo, Wikipedia, GitHub, arXiv, and Semantic Scholar (engines can be enabled or disabled via [config](docs/ARCHITECTURE.md#searxng-lifecycle-management))
- **URL scraping** — fetch-first with Playwright/Chromium fallback for JavaScript-heavy pages
- **Security databases** — NVD, CISA KEV, GitHub Advisories, OSV
- **Stack Exchange** — full network search and filtering
- **Real-time TUI** — per-researcher token and cost tracking

```
── Research: 70% ─────────────────────────────────────
┌───────┬────┐ 1 ┌─────┬────┐ 2 ┌────┬────┐ 3 ┌────┐
│SearXNG│     18k      │     36k     │     50k     │
│:55732 │   $0.0056    │   $0.0055   │   $0.0071   │
└───────┴──────────────┴─────────────┴─────────────┘
```


---

## Requirements

- Node.js `22.13.0` or any `24.x+` release
- The `pi` CLI installed and configured
- Docker daemon running (required for SearXNG)
- Internet access
- LLM in pi with minimum 100k context window (optimized for 100k+)  

---

## Install

```bash
pi install npm:@lincoln504/pi-research
```

The installation will automatically download and install:
- Node.js dependencies
- Playwright browser binaries (Chromium)

This process may take a few minutes on first install. If browser installation fails during postinstall, chromium will be installed automatically when you first use the research tool.

**Manual browser installation (if needed)**

```bash
npm run install:browsers
```

**From a checkout**

```bash
pi install .
```

---

## Platform Setup

**macOS** — Install Docker Desktop and start it from Applications.

**Linux** — Install Docker for your distribution ([docs.docker.com/engine/install](https://docs.docker.com/engine/install)), then:
```bash
# Start Docker
sudo systemctl start docker
sudo systemctl enable docker

# Add your user to docker group (then log out and back in)
sudo usermod -aG docker $USER
```

**Windows** — Install Docker Desktop (Linux containers). Detecting named pipes is automatic.

> **Note**: The first time you use `pi install` on a fresh system, Docker may not be running yet. The extension will check Docker when you actually use the research tool, not during install.

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
| `SEARXNG_URL` | — | External SearXNG base URL (e.g. `http://localhost:8080`). When set, Docker container management is skipped entirely and this URL is used directly |
| `BRAVE_SEARCH_API_KEY` | — | Enables `braveapi` engine (official REST API) |
| `PI_RESEARCH_VERBOSE` | — | Set to `1` to write diagnostic JSONL logs to a temp file (see below) |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | — | Skip startup health check (set to `1` if engines are blocked) |
| `PROXY_URL` | — | Proxy for SearXNG outgoing requests (e.g. `socks5://127.0.0.1:9050`) |
| `STACKEXCHANGE_API_KEY` | — | Stack Exchange API key (increases limit from 300 to 10,000/day) |
| `PI_RESEARCH_SEARCH_LANGUAGE` | `en-US` | BCP 47 language tag for search result filtering |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `240000` | Per-researcher timeout (30s to 10m) |
| `PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS` | `3` | Maximum researchers running simultaneously (1 to 10) |
| `PI_RESEARCH_CONSOLE_RESTORE_DELAY_MS` | `15000` | Delay before TUI clears after research ends |
| `SEARXNG_IMAGE_TAG` | `latest` | SearXNG Docker image tag — pin to a specific release for reproducibility (e.g. `2024.12.23`) |

**Verbose logging**

Set `PI_RESEARCH_VERBOSE=1` (or pass `--verbose`) to enable diagnostic output. Logs are written as JSONL to `{os.tmpdir()}/pi-research-debug-{hash}.log` — one file per session, never written to stdout. Each log line includes a session correlation ID so multiple concurrent sessions are distinguishable. The log path is printed to stderr on startup when verbose mode is active.

---

## Development & Release

**Commands**
- `npm run lint` / `npm run lint:fix`: Code quality
- `npm run type-check`: TypeScript verification
- `npm run test:unit`: Unit tests — no dependencies
- `npm run test:integration`: Integration tests — requires Docker; uses Testcontainers to spin up a real SearXNG instance (runs locally and in CI)

**Release**
1. `npm version patch` (or minor/major)
2. `git push origin main --tags`
The GitHub Action will automatically publish to npm.

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed design information.
