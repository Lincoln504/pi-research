![pi-research banner](docs/assets/README-banner.jpg)

<a href="https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Lincoln504/pi-research/ci.yml?style=flat-square&branch=main" /></a> <a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a>

Multi-agent web research for [pi](https://github.com/badlogic/pi-mono). Uses a self-hosted SearXNG container to search the web, scrape pages, check security databases, and shows everything in real-time.

---

## Why This Extension

Other ways to connect pi to the internet exist. This one is designed differently.

**Self-hosted search** — Uses SearXNG running in Docker. Free, no API keys. One container serves all research sessions — no duplicate instances, no overhead. Point `SEARXNG_URL` at an existing instance to skip container management.

**Multi-agent research** — AI coordinator breaks your question into parallel research tracks. Each track runs in a separate subagent. An AI evaluator combines results or launches deeper rounds.

**Safe by design** — Researcher agents cannot write files, edit files, or run shell commands. Web tools are isolated and rate-limited to keep agents focused.

**Minimal setup** — Just install. A system prompt guides pi on when and how to use the tool. No advanced prompting required. Works alongside other tools without conflicts.

---

## What It Does

- **Web search** — SearXNG aggregates Bing, Brave, Yahoo, DuckDuckGo, Wikipedia, GitHub, arXiv, and Semantic Scholar. Engines can be enabled or disabled in config.
- **URL scraping** — Fast HTML fetching with Playwright/Chromium for JavaScript-heavy pages
- **Security databases** — NVD, CISA KEV, GitHub Advisories, and OSV
- **Stack Exchange** — Full network search and filtering
- **Real-time TUI** — Per-researcher token and cost tracking

```
── Research: 70% ─╮
┌───────┬──────┐ 1 ┌──────┬──────┐ 2 ┌──────┬──────┐ 3 ┌──────┐
│SearXNG│  18k │     36k      │     50k      │     61k  │
│:55732 │$0.006│   $0.0055    │   $0.0071    │  $0.0089 │
└───────┴──────┴──────────────┴──────────────┴──────────┘
```

---

## Requirements

- Node.js 22.13.0 or 24.x+
- pi CLI installed and configured
- Docker running (required for SearXNG)
- Internet access
- LLM in pi with 100k+ context window

---

## Install

```bash
pi install npm:@lincoln504/pi-research
```

This installs dependencies and Playwright browsers. Takes a few minutes on first install.

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

**macOS** — Install Docker Desktop and start it from Applications.

**Linux** — Install Docker for your distribution:
```bash
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker $USER  # Log out and back in
```

**Windows** — Install Docker Desktop (Linux containers).

---

## Usage

Just talk to pi — the `research` tool registers automatically, no special slash command needed.

```
research the latest developments in WebAssembly
deep research AI inference hardware landscape
deep research CVE-2024-3094 at depth 3
```

Say **research** for a quick lookup. Say **deep research** for thorough investigation — pi selects depth 1–3 based on your query's scope and complexity, or pin it with **at depth N**.

A `/research <query>` slash command is also available as a shortcut — it runs quick mode (depth 0) directly.

**Depth levels**:

| Depth | Mode   | Researchers | Rounds |
|-------|--------|-------------|--------|
| 0     | Quick  | 1           | 1      |
| 1     | Normal | 2           | 2      |
| 2     | Deep   | 3           | 3      |
| 3     | Ultra  | 5           | 5      |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_URL` | — | External SearXNG URL (e.g., `http://localhost:8080`). Set this to skip Docker management. |
| `BRAVE_SEARCH_API_KEY` | — | Enables `braveapi` engine (official REST API). |
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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed design information.
