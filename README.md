![pi-research banner](docs/assets/README-banner.jpg)

<a href="https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Lincoln504/pi-research/ci.yml?style=flat-square&branch=main" /></a> <a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a>

Multi-agent web research for [pi](https://github.com/badlogic/pi-mono). Uses a high-fidelity stealth browser system to search the web, scrape pages, check security databases, and shows everything in real-time.

---

## Why This Extension

**High-Fidelity Stealth Research** — Uses `camoufox` (stealth Firefox) to bypass bot detection. No search API keys or external infrastructure required.

**Multi-agent Orchestration** — AI coordinator breaks your question into parallel research tracks. Each track runs in a separate researcher session. An AI evaluator combines results or launches deeper rounds.

**Safe by design** — Researcher agents cannot write files, edit files, or run shell commands. Web tools are isolated and rate-limited to keep agents focused.

**Minimal setup** — Just install. A system prompt guides pi on when and how to use the tool. No advanced prompting required. Works alongside other tools without conflicts.

---

## What It Does

- **Web Search** — Multi-threaded, parallel search bursts using DuckDuckGo Lite.
- **URL Scraping** — Configurable batch scraping protocol (1-16 batches or unlimited) with PDF support and global deduplication.
- **Security Databases** — NVD, CISA KEV, GitHub Advisories, and OSV.
- **Stack Exchange** — Full network search and filtering.
- **Real-time TUI** — Live progress tracking with token and cost monitoring.
- **Local Context** — Integrated `ripgrep` for searching local codebases.

---

## Requirements

- Node.js >= 22.13.0
- pi CLI installed and configured
- Internet access
- LLM in pi with 100k+ context window

---

## Install

```bash
pi install npm:@lincoln504/pi-research
```

This installs dependencies and the stealth browser engine. Takes a few minutes on first install.

**Local install** (from repo):

```bash
pi install .
```

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
| `PI_RESEARCH_MAX_CONCURRENT` | `3` | Max concurrent researchers (1-10). |
| `PI_RESEARCH_BROWSER_HEADLESS` | `true` | Run research browser in headless mode. |
| `PI_RESEARCH_EXPORT_DIR` | `cwd` | Directory for final research reports. |
| `PI_RESEARCH_VERBOSE` | — | Set to `1` for diagnostic logs. |
| `PROXY_URL` | — | Proxy for outgoing requests (e.g., `socks5://127.0.0.1:9050`). |
| `STACKEXCHANGE_API_KEY` | — | Stack Exchange API key (increases limit). |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `240000` | Per-researcher timeout (default 4m). |

---

## Development

**Commands**
- `npm run lint` / `npm run lint:fix` — Code quality
- `npm run type-check` — TypeScript verification
- `npm run test:unit` — Unit tests
- `npm run test:integration` — Integration tests
- `npm run test:coverage` — Coverage report

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed design information.
