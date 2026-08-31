<p align="center">
  <img src="https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/banner.jpg" alt="pi-research: free unlimited web search and knowledge store for agents" width="100%" />
</p>

<p align="center">
  <strong>Free unlimited web search &amp; knowledge store for agents</strong>
</p>

<p align="center">
  <a href="docs/PI-EXTENSION.md">Pi extension</a>
  ·
  <a href="docs/AGENT-SKILL.md">Agent skill</a>
  ·
  <a href="docs/SDK.md">SDK</a>
  ·
  <a href="docs/KNOWLEDGE-STORE.md">Knowledge store</a>
  ·
  <a href="docs/CONFIGURATION.md">Configuration</a>
  ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

---

<a href="https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Lincoln504/pi-research/ci.yml?style=flat-square&branch=main" /></a><br />
<a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a><br />
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-97ca00?style=flat-square" /></a><br />
<a href="https://github.com/Lincoln504/pi-research"><img alt="GitHub repository" src="https://img.shields.io/badge/GitHub-Lincoln504%2Fpi--research-181717?style=flat-square&logo=github&logoColor=white" /></a>

Search and scraping run locally through a stealth browser with no search provider and no monthly cap. The only cost is LLM tokens.

### Install

As a [Pi](https://github.com/earendil-works/pi) Coding Agent extension:

```bash
pi install npm:@lincoln504/pi-research
```

Standalone, as an [agent skill](docs/AGENT-SKILL.md) for Claude Code, Codex, and other skills-compatible agents:

```bash
npm install -g @lincoln504/pi-research
pi-research skill install
```

On npm ≥11.19 (and npm 12), dependency install scripts are skipped by default. This
package needs none of them: better-sqlite3 13 ships prebuilt bindings for every
supported platform inside its own tarball, and the stealth browser (~500MB)
self-provisions on its first use instead of at install time — so the first scrape
takes a few minutes. Nothing needs approving. (On older npm, which still runs
scripts, a Windows machine without Visual Studio Build Tools can fail while npm
needlessly recompiles better-sqlite3; upgrading npm fixes that too.)

In pi it works out of the box on the session's model and pi's configuration. Standalone use ([agent skill](docs/AGENT-SKILL.md) or [SDK](docs/SDK.md)) needs a model configured. See [Configuration](docs/CONFIGURATION.md).

### How it works

A research run loops through agent teams: a coordinator plans and starts with a search, researcher agents scrape and read in parallel, and a research lead decides whether to go another round — then writes the report from every report collected. The result is one cited Markdown report with findings optionally saved to the knowledge store.

Three depth levels (normal, deep, ultra) set the team size and number of rounds. A natural-language request is enough — the tool picks the right one:

![Prompt-driven multi-round research in the pi TUI](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/02-prompt-research.gif)

### Use cases

- Researching inside pi. Plug and play with no API key needed.
- Researching from Claude Code, Codex, or another coding agent while a cheaper or local model drives the run, so it doesn't spend the main agent's budget.
- Keeping a persistent and searchable knowledge store of findings, scoped globally or per project.
- Building agent systems that find and read web content, or populating a dataset of web sources.

### Why

- **No quota and no monthly fee.** Most AI search providers cap free searches and then charge, with results served from their index on their servers. pi-research searches and scrapes locally through DuckDuckGo in a stealth browser.
- **The index is local.** Every finding can be saved to a local [LanceDB](https://lancedb.com) knowledge store that seeds future runs, so repeat questions get faster and cheaper answers.
- **Read-only by design.** The research agent cannot run shell commands or write, edit, or delete anything — the right shape for an agent whose whole job is reading untrusted web pages. Prompt injection picked up mid-run has nothing to act on.
- **Search a little or a lot.** Depth levels range from a quick pass to a large-scale investigation.

### Requirements / limitations

- Node.js >= 22.19.0
- An LLM with a 100k+ context window (an API key or a local model)
- Internet access on a residential IP, since search, scraping, and YouTube transcripts get bot-blocked from datacenter/VPS/cloud IPs
- pi. The pi extension uses the host's copy while the standalone CLI and agent skill install it as a dependency.
- Local knowledge-store embeddings need `@huggingface/transformers`, which is an **optional dependency**: if its native image chain (sharp) cannot install on your machine, npm skips it with a warning, the install still succeeds, and everything except local embeddings works. The store disables embeddings gracefully with a message telling you how to restore them.
- Cloudflare Turnstile and similar systems block scraping on some sites. A run compensates with a wide pool of search results to scrape.

### Channels

npm (`npm:@lincoln504/pi-research`) is the stable channel and is kept current with breaking pi changes. A git install is the development channel. It has the latest commits and breaks first.

### License

MIT. Bundled third-party licenses are listed in [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md).

### Package identity

This project is always `@lincoln504/pi-research` on npm. The `pi-research` (unscoped) package is unrelated and deprecated.

### Versioning

pi-research typically follows the latest pi version and is not actively backwards compatible.
