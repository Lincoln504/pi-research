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
  <a href="https://github.com/Lincoln504/pi-research/blob/main/docs/DOCUMENTATION-ES.md">ES</a>
  ·
  <a href="https://github.com/Lincoln504/pi-research/blob/main/docs/DOCUMENTATION-ZH.md">中文研究</a>
  ·
  <a href="https://github.com/Lincoln504/pi-research/blob/main/docs/DOCUMENTATION-JA.md">日本語研究</a>
</p>

---

<a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a><br />
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-97ca00?style=flat-square" /></a><br />
<a href="https://github.com/Lincoln504/pi-research"><img alt="GitHub repository" src="https://img.shields.io/badge/GitHub-Lincoln504%2Fpi--research-181717?style=flat-square&logo=github&logoColor=white" /></a>

Search and scraping run locally in a stealth browser, with no search provider and no monthly cap. The only cost is LLM tokens.

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

No extra setup is needed. The package ships ready-made bindings for every platform and declares no build step. The stealth browser (about 1 GB) is downloaded once, at install or on the first scrape depending on your npm version (see [Troubleshooting](docs/TROUBLESHOOTING.md#the-first-scrape-takes-minutes-or-install-downloads-over-a-gigabyte)).

In pi, the extension works out of the box on the session's model and pi's configuration. Standalone use ([agent skill](docs/AGENT-SKILL.md) or [SDK](docs/SDK.md)) needs a model configured. See [Configuration](docs/CONFIGURATION.md).

If something does not work, start with [Troubleshooting](docs/TROUBLESHOOTING.md).

### Update

`pi update --extensions` moves every installed extension to its newest published version; `pi update npm:@lincoln504/pi-research` targets only this one. A versioned source (`npm:@lincoln504/pi-research@1.7.9`) is pinned and never updates; remove and reinstall it to move versions. Restart open pi sessions afterwards.

### Uninstall

`pi remove npm:@lincoln504/pi-research` removes the extension; `npm uninstall -g @lincoln504/pi-research` removes the standalone engine. Neither removes skill links into other agents, the state directory (`~/.pi/research/state`) or the cache (`~/.cache/pi-research`). Run `pi-research skill uninstall` first, then `pi-research cleanup`. See [AGENT-SKILL.md](docs/AGENT-SKILL.md#installation-flow) for the full picture.

### How it works

A research run works in rounds. A coordinator plans each round and starts the first search, researcher agents scrape and read pages in parallel, and a research lead then either starts another round or writes the final report from everything collected. The result is one cited Markdown report, optionally saved to the knowledge store.

Three depth levels (normal, deep, ultra) set the team size and number of rounds; an opt-in quick mode (depth 0) answers a simple question in one pass with no team. Just describe what you need in plain language, and the tool picks the right one:

![Two research runs in parallel in the pi TUI](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/hero.png)

### Use cases

- Researching inside pi. No search subscription needed.
- Researching from Claude Code, Codex, or another coding agent while a cheaper or local model drives the run. The main agent's budget stays untouched.
- Saving findings to a persistent, searchable knowledge store, scoped globally or per project.
- Building agent systems that find and read web content, or collecting a dataset of web sources.

### Why

- No quota and no monthly fee. Most AI search providers cap free searches and then charge, serving results from their own index. pi-research searches and scrapes locally through DuckDuckGo in a stealth browser.
- The index is local. Findings can be saved to a local [LanceDB](https://lancedb.com) knowledge store that seeds future runs. Repeat questions get faster and cheaper answers.
- Read-only by design. The research agent cannot run shell commands or write, edit, or delete anything. Prompt injection picked up mid-run has nothing to act on.
- Search a little or a lot. Depth levels range from a quick pass to a large-scale investigation.

### Requirements / limitations

- Node.js >= 22.22.2
- An LLM with a 100k+ context window (an API key or a local model)
- Internet access on a residential IP, since search, scraping, and YouTube transcripts get bot-blocked from datacenter/VPS/cloud IPs
- pi (`@earendil-works/pi-coding-agent`) 0.99.0 or newer, including the 1.x line. A host newer than the last version this release was tested against still runs, with a one-line notice; the tested ceiling is in `src/core/pi-version.ts`. The standalone CLI and skill use the host packages as peer dependencies (see [Troubleshooting](docs/TROUBLESHOOTING.md#the-agent-skill-or-cli-says-cannot-start--missing-required-runtime-dependencies)).
- Local knowledge-store embeddings need `@huggingface/transformers`, an optional dependency. If its native image chain (sharp) cannot install, npm skips it with a warning and the install still succeeds, so everything works except local embeddings. The store tells you how to restore them. Prefer no embedding model at all? Set `PI_RESEARCH_KNOWLEDGE_STORE_RETRIEVAL=bm25` for a pure lexical (BM25) knowledge store — see [KNOWLEDGE-STORE.md](docs/KNOWLEDGE-STORE.md).
- Cloudflare Turnstile and similar systems block scraping on some sites. A run compensates with a wide pool of search results to scrape.

### License

MIT. Bundled third-party licenses are listed in [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md).

### Notes

The package is always `@lincoln504/pi-research` on npm; the unscoped `pi-research` package is unrelated and deprecated. npm is the stable channel; a git install has the latest commits and receives breaking changes first. pi-research typically follows the latest pi version and is not actively backwards compatible.
