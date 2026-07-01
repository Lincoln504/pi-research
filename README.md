<p align="center">
  <img src="docs/banner.jpg" alt="pi-research" width="100%" />
</p>

<p align="center">
  <strong>Limitless web research with knowledge store — usable from Pi, agent skill, or SDK.</strong>
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

<a href="https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Lincoln504/pi-research/ci.yml?style=flat-square&branch=main" /></a> <a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a>

A coordinator breaks a question into parallel research tracks, each researcher searches
and scrapes the live web through a stealth browser, and an evaluator decides whether the
answer is complete or another round is needed. The result is a single cited Markdown report.

One engine backs several front-ends — the [pi](https://github.com/badlogic/pi-mono)
extension, a standalone CLI / agent skill (the same skill any skills-aware host runs,
including OpenClaw), and a programmatic SDK.

Ask in natural language — the tool understands the depth needed:

![Prompt-driven multi-round research in the pi TUI](docs/media/02-prompt-research.gif)

### Requirements

- Node.js >= 22.19.0
- An LLM with a 100k+ context window (bring your own key)
- Internet access
- A residential IP address — search, scraping, and YouTube transcripts all rely on a residential connection. A datacenter/VPS/cloud IP gets bot-blocked by the providers these features depend on.

### Install

Install the front-end you want.

pi extension

```bash
pi install npm:@lincoln504/pi-research
```

Standalone CLI / agent skill

```bash
npm install -g @lincoln504/pi-research
```

See [Agent skill](docs/AGENT-SKILL.md) for details.

Development build (bleeding edge)

```bash
pi install git:https://github.com/Lincoln504/pi-research.git
```

Or from a local clone:

```bash
git clone https://github.com/Lincoln504/pi-research.git
cd pi-research
pi install .
```

npm is the stable channel; the git install is the development channel (see Stability, below). The first install pulls the stealth browser engine, which takes a few minutes.

### Built with

Browser & scraping

- [Camoufox](https://camoufox.com) — stealth Firefox (driven via [Playwright](https://playwright.dev)) for undetected search and scraping
- [poolifier](https://github.com/poolifier/poolifier) — the worker-process pool behind the browser workers
- [html-to-markdown](https://github.com/Goldziher/html-to-markdown) & [node-html-markdown](https://github.com/crosstype/node-html-markdown) — convert scraped HTML to Markdown
- `pdf-oxide-wasm` — PDF text extraction (Rust/WASM)

Knowledge store & embeddings

- [Transformers.js](https://github.com/huggingface/transformers.js) — local embedding inference (model execution via ONNX Runtime)
- Google [Dawn](https://dawn.googlesource.com/dawn) — the WebGPU backend, accessed through the `webgpu` Node binding
- [LanceDB](https://lancedb.com) — on-disk vector database
- [Apache Arrow](https://arrow.apache.org) — the columnar schema the vector table is built on

YouTube transcripts

- [youtubei.js](https://github.com/LuanRT/YouTube.js) — YouTube internal-API client
- [BgUtils](https://github.com/LuanRT/BgUtils) — BotGuard PoToken generation
- [jsdom](https://github.com/jsdom/jsdom) — DOM environment for minting the PoToken

Host & runtime

- [pi](https://github.com/badlogic/pi-mono) — the host runtime, agent SDK, and TUI toolkit
- [TypeBox](https://github.com/sinclairzx81/typebox) — runtime config schema and validation

### Stability (v1.0.0)

v0.1.13 (April 20, 2026) was the last release before an extended break. Upstream
pi/SDK API changes and a re-architecture around the stealth-browser stack left the
extension non-functional for about eight weeks, until it stabilized in mid-June 2026.

From v1.0.0 on:

- npm (`npm:@lincoln504/pi-research`) is the stable channel, kept current with breaking pi changes.
- A git install is the development channel: latest commits, first to break.

### License

MIT
