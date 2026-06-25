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

After the global CLI is installed, link the `research` skill into the coding
agents on your machine so any of them can call it:

```bash
pi-research skills                 # detect installed harnesses + show install state
pi-research install-skill --all    # symlink the skill into all detected, confirmed targets
pi-research install-skill cursor   # opt into a specific (path-unverified) target by name
pi-research uninstall-skill --all  # remove every install pi-research created
```

`--all` covers the confirmed targets (Claude Code at `~/.claude/skills`, pi at
`~/.pi/skills`). Other targets — Cursor, Codex, and the cross-tool
`~/.agents/skills` convention — are opt-in by name because their skill paths are
community-reported rather than officially documented. The installer never
overwrites a non-pi-research `research` skill, records everything it creates, and
removes exactly that on `uninstall-skill` (and automatically on `npm uninstall`).
Use `--copy` instead of a symlink, or `--dry-run` to preview.

## Usage

In pi, just ask — the model invokes the research tool from natural language and
chooses the depth itself:

```bash
pi -p "research the latest developments in WebAssembly"
```

---

## Documentation

- [Pi extension](docs/PI-EXTENSION.md) — commands, the live TUI, and the extension lifecycle.
- [Agent skill](skills/research/README.md) — the portable skill that gives any coding agent research via the CLI.
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
