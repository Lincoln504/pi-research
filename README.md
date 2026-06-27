![pi-research banner](docs/README-banner.jpg)

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

## Install

```bash
pi install npm:@lincoln504/pi-research                  # pi extension
openclaw plugins install npm:@lincoln504/pi-research    # OpenClaw plugin
npm install -g @lincoln504/pi-research                  # standalone CLI / agent skill
pi install .                                            # local, from a clone
```

The first install pulls the stealth browser engine, which takes a few minutes.

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
- [SDK](docs/SDK.md) — the programmatic library.
- [Configuration](docs/CONFIGURATION.md) — the TUI settings, every environment variable, and how config layers resolve.
- [Knowledge store](docs/KNOWLEDGE-STORE.md) — the local vector cache of past findings.
- [Architecture](docs/ARCHITECTURE.md) — how the engine is built: layers, services, and the research pipeline.

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

## License

MIT

