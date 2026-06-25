![pi-research banner](docs/README-banner.jpg)

<a href="https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Lincoln504/pi-research/ci.yml?style=flat-square&branch=main" /></a> <a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a>

Multi-agent web research for [pi](https://github.com/badlogic/pi-mono). A coordinator
breaks a question into parallel research tracks, each researcher searches and scrapes
the live web through a stealth browser, and an evaluator decides whether the answer is
complete or another round is needed. The result is a single cited Markdown report.

---

## Why

- **Reads the open web directly.** Search runs through `camoufox` (a stealth Firefox)
  rather than a paid search API, so there is no search key to manage, no per-query rate
  limit, and no infrastructure to stand up. You still bring your own LLM key.
- **Parallel by default.** A question is decomposed into independent researcher sessions
  that run at the same time, so a broad topic is covered in breadth without you having to
  split it up yourself.
- **Safe to hand to an agent.** Researchers can search and scrape, but they cannot write
  files, edit files, or run shell commands. The web tools are isolated and rate-limited,
  which keeps an autonomous agent on task and contained.
- **One engine, several front-ends.** The same core backs the pi extension, a standalone
  CLI / agent skill, the OpenClaw plugin, and a programmatic SDK — so it fits wherever you
  already work, and a fix in the engine reaches all of them at once.

## What it does

- **Web search** — parallel search bursts over DuckDuckGo Lite.
- **Scraping** — batched, deduplicated page scraping with PDF support.
- **Security databases** — NVD, CISA KEV, GitHub Advisories, and OSV.
- **Stack Exchange** — full network search and filtering.
- **Local knowledge store** — an opt-in vector database of past findings, searched
  before going live so a repeat question can be answered from local results without a
  new web run.
- **Real-time TUI** — live progress, so a long multi-agent run is observable: which
  researcher is active, what it is scraping, and the running token and cost totals,
  rather than waiting blind.

---

## Requirements

- Node.js >= 22.19.0
- An LLM with a 100k+ context window
- Internet access

## Install

```bash
pi install npm:@lincoln504/pi-research        # pi extension
openclaw plugins install npm:@lincoln504/pi-research   # OpenClaw plugin
npm install -g @lincoln504/pi-research        # standalone CLI / agent skill
pi install .                                  # local, from a clone
```

The first install pulls the stealth browser engine, which takes a few minutes.

### Install the skill into your coding agents

Installation is driven from the pi extension's config menu. Run `/research-config`
and choose:

- **Install Skill in Coding Agents** — symlinks the `pi-research` skill into Claude
  and Codex (whichever are installed on your machine).
- **Uninstall Skill from Coding Agents** — removes the symlinks it created.

The installer detects which agents are present, symlinks the skill into each
(`~/.claude/skills`, `~/.codex/skills`), never overwrites an unrelated skill
already occupying that slot, and records everything it creates so uninstall
removes exactly that — also automatically on `npm uninstall`.

Cursor is not auto-installed: it has no global skills directory and only reads
project-level `.cursor/skills/`. To use the skill in Cursor, symlink it into a
project: `ln -s "$(npm root -g)/@lincoln504/pi-research/skills/pi-research" .cursor/skills/pi-research`.

Prefer to do Claude/Codex by hand too? It is just a symlink, e.g.:

```bash
ln -s "$(npm root -g)/@lincoln504/pi-research/skills/pi-research" ~/.claude/skills/pi-research
```

## Usage

In pi, just ask — the model invokes the research tool from natural language and
chooses the depth itself:

```bash
pi -p "research the latest developments in WebAssembly"
```

---

## Documentation

- [Pi extension](docs/PI-EXTENSION.md) — commands, the live TUI, and the extension lifecycle.
- [Agent skill](skills/pi-research/README.md) — the portable skill that gives any coding agent research via the CLI.
- [OpenClaw plugin](docs/OPENCLAW.md) — install and use pi-research inside OpenClaw.
- [SDK & configuration](docs/SDK.md) — the programmatic library, plus the full configuration model and every environment variable.
- [Architecture](docs/ARCHITECTURE.md) — how the engine is built: layers, services, and the research pipeline.

---

## Development

```bash
npm run test:unit         # unit tests, no browser required
npm run test:integration  # requires camoufox (Xvfb only for the opt-in virtual-display tests)
npm run type-check        # TypeScript strict mode (src)
npm run type-check:tests  # TypeScript strict mode (tests)
npm run lint              # ESLint
npm run deps:check        # architectural rule enforcement
```

## License

MIT
