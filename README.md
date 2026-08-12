<p align="center">
  <img src="https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/banner.jpg" alt="pi-research: free unlimited web search and knowledge store for coding agents" width="100%" />
</p>

<p align="center">
  <strong>Free unlimited web search &amp; knowledge store for coding agents</strong>
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

Search and scraping run locally through a stealth browser with no search provider and no monthly cap. You pay only for the LLM tokens you use.

### Install

As a [pi](https://github.com/earendil-works/pi) extension:

```bash
pi install npm:@lincoln504/pi-research
```

Standalone, as an [agent skill](docs/AGENT-SKILL.md) for Claude Code, Codex, and OpenClaw:

```bash
npm install -g @lincoln504/pi-research
pi-research skill install
```

In pi it works out of the box on your session's model and pi's configuration. Standalone use (agent skill, CLI, or [SDK](docs/SDK.md)) needs a model configured. See [Configuration](docs/CONFIGURATION.md). The first install pulls the stealth browser engine, which takes a few minutes.

### How it works

A research run loops through agent teams: a coordinator plans and opens with a search, researcher agents scrape and read in parallel, and an evaluator decides whether to go another round or synthesize. The result is one cited Markdown report with findings optionally saved to the knowledge store.

Three depth levels (normal, deep, ultra) set the team size and number of rounds. Ask in natural language and the tool picks the right one:

![Prompt-driven multi-round research in the pi TUI](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/02-prompt-research.gif)

### Use cases

- Researching for your [Pi](https://github.com/earendil-works/pi) Coding Agent. Plug and play with no API key needed.
- Researching from Claude Code, Codex, OpenClaw, or another coding agent while a cheaper or local model drives the run so it doesn't spend your main agent's budget.
- Keeping a persistent and searchable knowledge store of findings, scoped globally or per project.
- Building agent systems that find and read web content or populating a dataset of web sources.

### Why pi-research

- **No quota and no monthly fee.** Most AI search providers cap free searches and then charge, with results served from *their* index on *their* servers. pi-research searches and scrapes locally through DuckDuckGo in a stealth browser.
- **You own your index.** Every finding is written to a local [LanceDB](https://lancedb.com) knowledge store that seeds future runs, so repeat questions get faster and cheaper answers.
- **Cited reports rather than raw dumps.** You get one sourced Markdown report instead of raw web content pasted into the conversation. Context efficient and easy to verify.
- **Read-only by design.** The research agent cannot run shell commands or write, edit, or delete anything. It can read and search files, so treat it as you would any read-only agent with access to your machine.
- **Search a little or a lot.** Depth levels span a quick pass to a large-scale investigation.

### Requirements / limitations

- Node.js >= 22.19.0
- An LLM with a 100k+ context window (bring your own key or use a local model)
- Internet access on a residential IP, since search, scraping, and YouTube transcripts get bot-blocked from datacenter/VPS/cloud IPs
- The [pi runtime](https://github.com/earendil-works/pi). The pi extension uses the host's copy while the standalone CLI and agent skill install it as a dependency.
- Cloudflare and similar systems block scraping on some sites. A run flags pages it can't reach and compensates with a wide pool of search results to cite.

### Channels

npm (`npm:@lincoln504/pi-research`) is the stable channel and is kept current with breaking pi changes. A git install is the development channel. It has the latest commits and breaks first.

### License

MIT. Bundled third-party licenses are listed in [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md).

### Package identity

This project is always `@lincoln504/pi-research` on npm. The `pi-research` (unscoped) package is unrelated and deprecated.
