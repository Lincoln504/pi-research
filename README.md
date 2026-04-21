![pi-research banner](docs/assets/README-banner.jpg)

<a href="https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Lincoln504/pi-research/ci.yml?style=flat-square&branch=main" /></a> <a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a>

Multi-agent web research for [pi](https://github.com/badlogic/pi-mono). Uses SearXNG for search, scrapes pages, queries security databases, and tracks everything in real-time.

## Why This Extension

**Self-hosted SearXNG** — Free, no API keys. Docker container shared across all research sessions.

**Safe by default** — Researcher agents cannot write files, edit files, or run shell commands. Web tools are isolated and rate-limited.

**Multi-agent orchestration** — AI coordinator runs parallel researchers, then synthesizes or delegates to deeper rounds.

**Minimal setup** — Just install. System prompt integrates automatically. Works alongside other tools without conflicts.

---

## Capabilities

- **Web search** — SearXNG (Bing, Brave, Yahoo, DuckDuckGo, Wikipedia, GitHub, arXiv, Semantic Scholar)
- **URL scraping** — Fetch-first with Playwright/Chromium fallback for JavaScript-heavy pages
- **Security databases** — NVD, CISA KEV, GitHub Advisories, OSV
- **Stack Exchange** — Full network search and filtering
- **Real-time TUI** — Per-researcher token and cost tracking

---

## Requirements

- Node.js 22.13.0 or 24.x+
- pi CLI installed and configured
- Docker running (required for SearXNG)
- Internet access
- LLM with 100k+ context window

---

## Install

```bash
pi install npm:@lincoln504/pi-research
```

This installs dependencies and Playwright browsers.

**Manual browser setup** (if needed):

```bash
npm run install:browsers
```

**Local install** (from repo):

```bash
pi install .
```

---

## Platform Setup

**macOS**: Install Docker Desktop and start it.

**Linux**: [Install Docker](https://docs.docker.com/engine/install), then:
```bash
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker $USER  # Log out and back in
```

**Windows**: Install Docker Desktop (Linux containers).

---

## Usage

Just ask pi for research. The `research` tool is registered automatically.

```
Research "binary search tree"
Do a deep dive on CVE-2024-3094 at depth 2
```

**Depth levels**:

| Depth | Mode | Researchers | Rounds |
|-------|-------|-------------|---------|
| 0     | Quick  | 1           | 1       |
| 1     | Normal | 2           | 2       |
| 2     | Deep   | 3           | 3       |
| 3     | Ultra  | 5           | 5       |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_URL` | — | External SearXNG URL. Set this to skip Docker management. |
| `BRAVE_SEARCH_API_KEY` | — | Enables Brave Search API. |
| `PI_RESEARCH_VERBOSE` | — | Set to `1` for diagnostic logs. |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | — | Skip startup health check (`1`). |
| `PROXY_URL` | — | Proxy for outgoing requests (e.g., `socks5://127.0.0.1:9050`). |
| `STACKEXCHANGE_API_KEY` | — | Stack Exchange API key (increases limit). |
| `PI_RESEARCH_SEARCH_LANGUAGE` | `en-US` | Search language filter (BCP 47). |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `240000` | Per-researcher timeout (30s-10m). |
| `PI_RESEARCH_MAX_CONCURRENT_RESEARCHERS` | `3` | Max concurrent researchers (1-10). |
| `PI_RESEARCH_CONSOLE_RESTORE_DELAY_MS` | `15000` | Delay before TUI clears after research. |
| `SEARXNG_IMAGE_TAG` | `latest` | Pin SearXNG Docker image version. |

**Verbose logging** — Logs written to `{os.tmpdir()}/pi-research-debug-{hash}.log` as JSONL. Each line includes session ID for concurrent sessions.

---

## Development

**Commands**
- `npm run lint` / `npm run lint:fix` — Code quality
- `npm run type-check` — TypeScript verification
- `npm run test:unit` — Unit tests
- `npm run test:integration` — Integration tests (requires Docker)
- `npm run test:coverage` — Coverage report

**Release**
1. `npm version patch` (or `minor`/`major`)
2. `git push origin main --tags`
3. GitHub Action publishes to npm automatically

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design details.
