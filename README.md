![pi-research banner](docs/banner.jpg)

<a href="https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Lincoln504/pi-research/ci.yml?style=flat-square&branch=main" /></a> <a href="https://www.npmjs.com/package/@lincoln504/pi-research"><img alt="npm version" src="https://img.shields.io/npm/v/@lincoln504/pi-research.svg?style=flat-square" /></a>

Multi-agent web research for [pi](https://github.com/badlogic/pi-mono). A coordinator
breaks a question into parallel research tracks, each researcher searches and scrapes
the live web through a stealth browser, and an evaluator decides whether the answer is
complete or another round is needed. The result is a single cited Markdown report.

One engine backs several front-ends — the pi extension, a standalone CLI / agent
skill, the OpenClaw plugin, and a programmatic SDK.

---

## Requirements

- Node.js >= 22.19.0
- An LLM with a 100k+ context window (bring your own key)
- Internet access
- A residential IP address — search, scraping, and YouTube transcripts all rely on a residential connection. A datacenter/VPS/cloud IP gets bot-blocked by the providers these features depend on.

## Install

One engine, several front-ends — install only the one you want. Each is a separate command.

**pi extension**

```bash
pi install npm:@lincoln504/pi-research
```

**OpenClaw plugin**

```bash
openclaw plugins install npm:@lincoln504/pi-research
```

**Standalone CLI / agent skill**

```bash
npm install -g @lincoln504/pi-research
```

**Development build (bleeding edge, from a git clone)**

```bash
git clone https://github.com/Lincoln504/pi-research.git
cd pi-research
pi install .
```

The npm commands above are the **stable** channel; the git clone is the **bleeding-edge / development** build — see [the stability note](#a-note-on-stability-v100) below. The first install of any front-end pulls the stealth browser engine, which takes a few minutes.

## Usage

In pi, just ask — the model invokes the research tool from natural language and
chooses the depth itself:

```bash
pi -p "research the latest developments in WebAssembly"
```

---

## Documentation

| Doc | What's inside |
|-----|---------------|
| [Pi extension](docs/PI-EXTENSION.md) | Commands, the live TUI, and the extension lifecycle. |
| [Agent skill](docs/AGENT-SKILL.md) | The portable skill that gives any coding agent research, and how it installs. |
| [OpenClaw plugin](docs/OPENCLAW.md) | Install and use pi-research inside OpenClaw. |
| [SDK](docs/SDK.md) | The programmatic library. |
| [Configuration](docs/CONFIGURATION.md) | The TUI settings, every environment variable, and how config layers resolve. |
| [Knowledge store](docs/KNOWLEDGE-STORE.md) | The local vector cache of past findings. |
| [Architecture](docs/ARCHITECTURE.md) | How the engine is built: layers, services, and the research pipeline. |

## Built with

**Browser & scraping**
- [Camoufox](https://camoufox.com) — stealth Firefox (driven via [Playwright](https://playwright.dev)) for undetected search and scraping
- [poolifier](https://github.com/poolifier/poolifier) — the worker-process pool behind the browser workers
- [html-to-markdown](https://github.com/Goldziher/html-to-markdown) & [node-html-markdown](https://github.com/crosstype/node-html-markdown) — convert scraped HTML to Markdown
- `pdf-oxide-wasm` — PDF text extraction (Rust/WASM)

**Knowledge store & embeddings**
- [Transformers.js](https://github.com/huggingface/transformers.js) — local embedding inference (model execution via ONNX Runtime)
- Google [Dawn](https://dawn.googlesource.com/dawn) — the WebGPU backend, accessed through the `webgpu` Node binding
- [LanceDB](https://lancedb.com) — on-disk vector database
- [Apache Arrow](https://arrow.apache.org) — the columnar schema the vector table is built on

**YouTube transcripts**
- [youtubei.js](https://github.com/LuanRT/YouTube.js) — YouTube internal-API client
- [BgUtils](https://github.com/LuanRT/BgUtils) — BotGuard PoToken generation
- [jsdom](https://github.com/jsdom/jsdom) — DOM environment for minting the PoToken

**Host & runtime**
- [pi](https://github.com/badlogic/pi-mono) — the host runtime, agent SDK, and TUI toolkit
- [TypeBox](https://github.com/sinclairzx81/typebox) — runtime config schema and validation

## A note on stability (v1.0.0)

Thank you for your patience. After the last tagged release (**v0.1.13**, April 20, 2026)
the extension broke within a couple of days and stayed effectively non-functional for
roughly eight weeks. Two things landed at once: a run of breaking changes in the
upstream pi/SDK API, and a ground-up re-architecture of the engine around the
stealth-browser search/scrape stack. Realigning to the moving API while rebuilding the
core took until mid-June 2026 to fully stabilize.

That period is over. **From v1.0.0 onward:**

- The **npm release** (`npm:@lincoln504/pi-research`) is the **stable** channel — kept working and updated to track the latest breaking pi changes.
- A **git install** (clone + `pi install .`) is the **bleeding-edge / development** build: the newest work, and the place breakage surfaces first.

Install the npm package unless you specifically want to track the latest commits.

## License

MIT

