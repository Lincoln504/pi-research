![pi-research banner](assets/README-banner.jpg)

[![npm version](https://img.shields.io/npm/v/pi-research.svg)](https://www.npmjs.com/package/pi-research)

Multi-agent web research for pi. Coordinate parallel researchers or run a single sub-agent on a query. Search the web, scrape URLs, query security databases, access Stack Exchange, search code, and track progress via terminal UI. Search multiple providers (Google, Bing, Brave, and others) with no cost thanks to [SearXNG](https://github.com/searxng/searxng).

### Capabilities

- Single-agent research (`quick: true`) - Fast, focused queries with one researcher
- Multi-agent research - Coordinator orchestrates parallel researchers for deep or comprehensive tasks
- Web search - SearXNG running in a Docker container
- URL scraping - Fetch first, then Playwright/Chromium for JavaScript-heavy pages
- Security databases - NVD, CISA KEV, GitHub Advisories, OSV
- Stack Exchange - Query Stack Overflow and the Stack Exchange network
- Code search - ripgrep (`rg`) with `grep` fallback for local queries
- Terminal UI - Real-time SearXNG status and researcher progress
- Proxy support - Optional SearXNG proxy configuration for controlled routing

### Requirements

- Node.js `22.13.0` or any supported `24.x+` release (`.nvmrc` pins `22.13.0`)
- The `pi` CLI installed and configured with a model provider/API key
- Docker installed and the Docker daemon running before web research starts
- Internet access for SearXNG search, scraping, Stack Exchange, and security database calls

Docker is required because pi-research runs its own SearXNG container for web search. On first use, pi-research checks Docker, pulls `searxng/searxng:latest` if the image is missing, creates the `pi-searxng` container, waits for it to become healthy, and reuses it while the pi session is active.

### Install From This Repo

Use these commands when working from a cloned checkout of this repository.

```bash
# Use the pinned Node version if you use nvm
nvm use

# Install Node dependencies
npm install

# Optional: create a reference config file for proxy/timeouts/API keys
cp .env.example .env

# Install the extension into pi
pi install .
```

You can also load the checkout for one session without installing it:

```bash
pi -e ./index.ts
```

### Install From npm

If you are installing the published package instead of a local checkout, use pi's package installer:

```bash
pi install npm:pi-research
```

After installing, start pi normally:

```bash
pi
```

### Platform Setup

**macOS**

Install and start Docker Desktop before using the research tool. Confirm the daemon is ready:

```bash
docker info
```

Then run pi:

```bash
pi
```

**Linux**

Install Docker Engine or Docker Desktop, then start the Docker daemon before using the research tool:

```bash
sudo systemctl start docker
docker info
```

If `docker info` fails with a permissions error, add your user to the `docker` group or run pi from an environment that can access Docker. The group change usually requires logging out and back in:

```bash
sudo usermod -aG docker "$USER"
```

**Windows**

Install and start Docker Desktop before using the research tool. Use Linux containers unless you have a specific reason not to. Confirm Docker is ready from PowerShell:

```powershell
docker info
```

Then run pi from PowerShell, Windows Terminal, or your normal development shell:

```powershell
pi
```

pi-research detects Docker Desktop named pipes on Windows. You normally do not need to set `DOCKER_SOCKET`.

### Usage

Once installed, ask pi for web research. The extension registers a `research` tool; pi's model chooses when to call it.

```text
Research "What is a binary search tree?"
```

For fast questions, ask for quick research:

```text
Research this in quick mode: "What changed in Node.js 22?"
```

For broader work, ask for deep or comprehensive research:

```text
Do deep research on the tradeoffs between SearXNG and commercial search APIs for agentic research tools.
```

The `research` tool accepts these parameters internally:

- `query` - Required research topic
- `quick` - Optional boolean; quick mode uses a single researcher
- `model` - Optional model id; defaults to the active pi model

By default, the extension prompt tells the model to prefer quick mode unless the user asks for deep, exhaustive, comprehensive, swarm, or multi-agent research.

### First Run Behavior

The first research call can take longer than later calls because pi-research may need to download the SearXNG image and start the container. Typical startup flow:

1. pi starts and the extension checks whether Docker is reachable.
2. The first `research` tool call initializes SearXNG.
3. If `searxng/searxng:latest` is missing, Docker pulls it.
4. pi-research creates or reuses the `pi-searxng` container.
5. The extension waits for the mapped local port, normally `http://localhost:55732`, to become ready.
6. Research begins and the terminal UI shows SearXNG and researcher progress.

The container is shared across research calls in the same pi process and is cleaned up through pi's session shutdown lifecycle. Session state is stored under your pi state directory, normally `~/.pi/state`, using OS-compatible paths.

### Docker And SearXNG Details

- Default image: `searxng/searxng:latest`
- Default container name: `pi-searxng`
- Default host port: `55732`
- Container config files: `config/default-settings.yml` and `config/limiter.toml`
- Docker connection discovery: `DOCKER_SOCKET`, then `DOCKER_HOST`, then platform defaults
- Linux host proxy support: adds `host.docker.internal:host-gateway`
- macOS/Windows host proxy support: uses Docker Desktop's built-in `host.docker.internal`

Useful Docker commands:

```bash
# Confirm Docker daemon access
docker info

# See the SearXNG container
docker ps --filter name=pi-searxng

# View SearXNG logs
docker logs pi-searxng

# Remove the image to force a fresh pull on next startup
docker rmi searxng/searxng:latest
```

### Configuration

pi-research reads configuration from `process.env`. Export variables in your shell, configure them in whatever launches pi, or use a tool such as `direnv` to load `.env`; the extension does not load `.env` files by itself. Start from `.env.example` when working from this repo.

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | - | Optional proxy URL for SearXNG, for example `socks5://127.0.0.1:9050`, `http://proxy.example.com:8080`, or `http://user:pass@proxy.example.com:8080`. Host loopback values `localhost` and `127.0.0.1` are mapped to Docker's portable `host.docker.internal` alias inside the container. |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `240000` | Per-researcher timeout in milliseconds. Must be between `30000` and `600000`. |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | see note | SearXNG health timeout in milliseconds. If unset, the network health check uses `15000` and container startup uses `120000`. If set, this value overrides both. |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `10` | Global terminal UI refresh debounce in milliseconds. |
| `PI_RESEARCH_VERBOSE` | - | Set to `1` to write JSONL diagnostics without passing `pi --verbose`. |
| `DOCKER_SOCKET` | platform default | Optional Docker socket override. Linux/macOS usually use `/var/run/docker.sock`; Windows Docker Desktop normally uses a named pipe such as `//./pipe/docker_engine`. |
| `DOCKER_HOST` | - | Optional Docker host override, for example `unix:///var/run/docker.sock`, `npipe:////./pipe/docker_engine`, or `tcp://127.0.0.1:2375`. |
| `STACKEXCHANGE_API_KEY` | - | Optional Stack Exchange API key for higher rate limits. Anonymous access is limited to about 300 requests/day; keyed access is about 10,000/day. |

Verbose diagnostics:

```bash
pi --verbose
```

or:

```bash
PI_RESEARCH_VERBOSE=1 pi
```

Logs are written as JSONL to your OS temp directory as `pi-research-debug-{hash}.log`, where `{hash}` is a unique 4-character suffix per process. Without verbose mode, no log files are created. Normal TUI, JSON/RPC, and headless runs do not receive diagnostic chatter on stdout or stderr.

### Terminal UI

Real-time progress tracking uses two panels. The left panel shows SearXNG status, port, and active connections. The right panel shows research progress with the active model, cumulative token usage, researcher columns, completion status, and tool results.

```text
+-------+ +-- Research | qwen/qwen3.5-35b-a3b  40.5k --+
|SearXNG| |            |                 |             |
|:55732 | |    OK1     |       OK2       |      3      |
|1      | |            |                 |             |
+-------+ +------------+-----------------+-------------+
```

### Troubleshooting

**pi shows a Docker warning or research fails before search starts**

Start Docker Desktop or the Docker daemon, then verify:

```bash
docker info
```

On Linux, also check Docker permissions if the daemon is running but the command fails.

**First run is slow**

This is expected if Docker needs to pull `searxng/searxng:latest`. Later runs should be faster unless the image was removed.

**SearXNG container does not become healthy**

Check the container and logs:

```bash
docker ps -a --filter name=pi-searxng
docker logs pi-searxng
```

If port `55732` is already in use, stop the conflicting service or remove the old container and retry.

**Proxy does not work from inside Docker**

Use a proxy URL that is reachable from the container. If the proxy runs on your host, `PROXY_URL=socks5://127.0.0.1:9050` is accepted; pi-research rewrites the host to `host.docker.internal` for the container. On Linux, pi-research adds the Docker `host-gateway` mapping automatically.

**JavaScript-heavy scraping fails with a Playwright/Chromium executable error**

Dependencies normally install Playwright's browser assets. If your package manager skipped postinstall scripts or browser downloads, install Chromium manually from the repo checkout:

```bash
npx playwright install chromium
```

**Code search cannot find `rg`**

The grep tool tries `rg` first and falls back to `grep`. For best performance, install ripgrep for your OS.

### Architecture

**Entry Point & Orchestration**
- Entry point (`index.ts`) registers the research tool and pi session lifecycle cleanup.
- Tool orchestration layer (`src/tool.ts`) validates config, initializes SearXNG, manages the TUI, and branches between quick and deep modes.

**Quick Mode (Single-Agent)**
- Runs one researcher session without a coordinator.
- Best for focused questions and normal web lookups.

Deep Mode (Multi-Agent)
- Orchestrator (`src/orchestration/deep-research-orchestrator.ts`) uses an AI coordinator to decompose the query into a research agenda.
- Researchers (`src/orchestration/researcher.ts`) run gathering, scraping, and reporting phases.
- Gathering is limited to four calls across search, security search, Stack Exchange, and grep per researcher.
- Scraping uses a two-call protocol: first handshake for already-scraped links, second execution for filtered URLs.
- The last researcher in a round is promoted to Lead Evaluator to synthesize or continue.
- Shared link tracking avoids duplicate scraping across researchers.

**Available Internal Tools**
- `search` - Web search through SearXNG.
- `scrape` - URL scraping through fetch and Playwright/Chromium fallback.
- `security_search` - Search security vulnerability databases (NVD, CISA KEV, GitHub Advisories, OSV). Filter by severity, CVE ID, package name, ecosystem, and actively exploited vulnerabilities.
- `stackexchange` - Stack Exchange REST API for technical Q&A (Stack Overflow, SuperUser, AskUbuntu, etc.). Use tags to filter by programming topics.
- `grep` - Local code search through `rg` or `grep` fallback.

Complexity assessment determines researcher count:

- Level 1 (brief) - 1 researcher for simple factual queries.
- Level 2 (normal) - 2 researchers for technical or multi-faceted topics.
- Level 3 (deep) - 3 researchers and potentially more rounds for nuanced analysis.

### Project Structure

```text
pi-research/
|-- index.ts                  # Extension entry point
|-- src/
|   |-- tool.ts               # Research tool orchestration
|   |-- config.ts             # Configuration management
|   |-- logger.ts             # Logging utilities
|   |-- orchestration/        # Swarm lifecycle and researcher sessions
|   |-- infrastructure/       # SearXNG Docker lifecycle and state manager
|   |-- tools/                # Search, scrape, security, Stack Exchange, grep
|   |-- web-research/         # Search and scraping utilities
|   |-- security/             # Security database integrations
|   |-- stackexchange/        # Stack Exchange API integration
|   |-- tui/                  # Terminal UI components
|   `-- utils/                # Shared utilities
|-- prompts/                  # Coordinator, researcher, and evaluator prompts
|-- config/                   # SearXNG settings and limiter config
|-- test/                     # Unit and integration tests
|-- .env.example              # Example configuration
|-- package.json              # Package metadata
`-- README.md                 # This file
```

### Development

```bash
# Install dependencies
npm install

# Type checking
npm run type-check

# Linting
npm run lint

# Unit tests
npm run test:unit

# Integration tests that need Docker/network access
npm run test:integration
```

Integration tests may pull and start SearXNG containers. Start Docker before running them.

### Release

Normal branch pushes and pull requests run validation only; they do not publish the package. npm publishing is gated by Git tags that match `v*.*.*`.

Release flow:

```bash
npm version patch
git push origin main
git push origin v0.1.1
```

The release workflow checks that the tag matches `package.json` exactly (`v${version}`), runs lint, type-check, unit tests, verifies package contents with `npm pack --dry-run`, and then publishes to npm using the `NPM_TOKEN` repository secret.

### Dependencies

All Node dependencies are installed with the extension. Docker itself must be installed separately.

- `@mariozechner/pi-coding-agent` - pi core SDK peer dependency
- `@sinclair/typebox` - Parameter schema validation peer dependency
- `@kreuzberg/html-to-markdown-node` - Native HTML-to-Markdown conversion when available
- `node-html-markdown` - Pure JavaScript HTML-to-Markdown fallback
- `js-yaml` - YAML parsing for generated SearXNG proxy settings
- `playwright` - Headless browser automation for JavaScript-heavy scraping
- `dockerode` - Docker API client for SearXNG container management
- Native `fetch` - Built-in Node.js HTTP requests for fast scraping

### License

MIT
