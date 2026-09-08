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
  ·
  <a href="docs/DOCUMENTATION-ES.md">ES</a>
  ·
  <a href="docs/DOCUMENTATION-ZH.md">中文研究</a>
  ·
  <a href="docs/DOCUMENTATION-JA.md">日本語研究</a>
</p>

---

<a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a><br />
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-97ca00?style=flat-square" /></a><br />
<a href="https://github.com/Lincoln504/pi-research"><img alt="GitHub repository" src="https://img.shields.io/badge/GitHub-Lincoln504%2Fpi--research-181717?style=flat-square&logo=github&logoColor=white" /></a>

Search and scraping run locally in a stealth browser, with no search provider and no monthly cap. The only cost is LLM tokens.

**Current recommended model:** [`inclusionai/ling-3.0-flash`](https://openrouter.ai/inclusionai/ling-3.0-flash) on OpenRouter.

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

No extra setup is needed. The package ships ready-made bindings for every platform and runs no install scripts. The stealth browser (~500MB) downloads on first use, so the first scrape takes a few minutes. npm ≥11.19 skips install scripts by default. Leave it that way: nothing needs approving or building. Only Windows with npm older than 11.19 can fail when the install tries to compile from source. Upgrading npm fixes it.

In pi, the extension works out of the box on the session's model and pi's configuration. Standalone use ([agent skill](docs/AGENT-SKILL.md) or [SDK](docs/SDK.md)) needs a model configured. See [Configuration](docs/CONFIGURATION.md).

### Uninstall

`pi remove npm:@lincoln504/pi-research` removes the extension. `npm uninstall -g @lincoln504/pi-research` removes the standalone engine. npm 7+ no longer runs `preuninstall`, so **nothing else is removed on its own**: skill links into other agents (Claude Code, Codex, …), the state directory (`~/.pi/research/state`), and the cache (`~/.cache/pi-research`, including any downloaded embedding models) stay in place. Remove the skill links first with `pi-research skill uninstall` (or `/research-config` → Remove from External Agents). The shared stealth-browser cache (`~/.cache/camoufox`) is preserved unless `PI_RESEARCH_PURGE_BROWSERS=1`. See [AGENT-SKILL.md](docs/AGENT-SKILL.md#installation-flow) for the full picture.

### How it works

A research run works in rounds. A coordinator plans each round and starts the first search, researcher agents scrape and read pages in parallel, and a research lead then either starts another round or writes the final report from everything collected. The result is one cited Markdown report, optionally saved to the knowledge store.

Three depth levels (normal, deep, ultra) set the team size and number of rounds. Just describe what you need in plain language, and the tool picks the right one:

![Two research runs in parallel in the pi TUI](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/hero.png)

### Use cases

- Researching inside pi. No API key needed.
- Researching from Claude Code, Codex, or another coding agent while a cheaper or local model drives the run. The main agent's budget stays untouched.
- Saving findings to a persistent, searchable knowledge store, scoped globally or per project.
- Building agent systems that find and read web content, or collecting a dataset of web sources.

### Why

- **No quota and no monthly fee.** Most AI search providers cap free searches and then charge, serving results from their own index. pi-research searches and scrapes locally through DuckDuckGo in a stealth browser.
- **The index is local.** Findings can be saved to a local [LanceDB](https://lancedb.com) knowledge store that seeds future runs. Repeat questions get faster and cheaper answers.
- **Read-only by design.** The research agent cannot run shell commands or write, edit, or delete anything. Prompt injection picked up mid-run has nothing to act on.
- **Search a little or a lot.** Depth levels range from a quick pass to a large-scale investigation.

### Requirements / limitations

- Node.js >= 22.19.0
- An LLM with a 100k+ context window (an API key or a local model)
- Internet access on a residential IP, since search, scraping, and YouTube transcripts get bot-blocked from datacenter/VPS/cloud IPs
- pi. The pi extension uses the host's copy while the standalone CLI and agent skill install it as a dependency.
- Local knowledge-store embeddings need `@huggingface/transformers`, an **optional dependency**. If its native image chain (sharp) cannot install, npm skips it with a warning and the install still succeeds, so everything works except local embeddings. The store tells you how to restore them.
- Cloudflare Turnstile and similar systems block scraping on some sites. A run compensates with a wide pool of search results to scrape.

### Channels

npm (`npm:@lincoln504/pi-research`) is the stable channel and is kept current with breaking pi changes. A git install is the development channel. It has the latest commits and receives breaking changes first.

### License

MIT. Bundled third-party licenses are listed in [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md).

### Package identity

This project is always `@lincoln504/pi-research` on npm. The `pi-research` (unscoped) package is unrelated and deprecated.

### Versioning

pi-research typically follows the latest pi version and is not actively backwards compatible.
