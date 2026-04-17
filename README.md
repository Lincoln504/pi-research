![pi-research banner](assets/README-banner.jpg)

[![npm version](https://img.shields.io/npm/v/@lincolndeen/pi-research.svg)](https://www.npmjs.com/package/@lincolndeen/pi-research)

Multi-agent web research for pi. Coordinate parallel researchers or run a single sub-agent on a query. Search the web, scrape URLs, query security databases, access Stack Exchange, search code, and track progress via terminal UI. Search multiple providers (Google, Bing, Brave, and others) with no cost thanks to [SearXNG](https://github.com/searxng/searxng).

### Capabilities

- Multi-agent web research - Coordinate parallel researchers for deep analysis
- Quick mode - Single researcher for fast queries
- Web search - SearXNG running in a Docker container
- URL scraping - Fetch first, then Playwright/Chromium for JavaScript-heavy pages
- Security databases - NVD, CISA KEV, GitHub Advisories, OSV
- Stack Exchange - Query Stack Overflow and the Stack Exchange network
- Code search - ripgrep (`rg`) with `grep` fallback for local queries
- Real-time TUI - Tracks research progress in the terminal
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

```bash
pi install npm:@lincolndeen/pi-research
```

**Note:** Package name is `@lincolndeen/pi-research` (scoped npm package). After installing, start pi normally with `pi`. 

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
Research "Latest Node.js 22 release notes"
```

The extension uses a `depth` parameter to control research intensity:

- **depth 0 (default)**: Quick mode - single researcher, 1 round
- **depth 1**: Normal mode - 2 researchers, up to 2 rounds
- **depth 2**: Deep mode - 3 researchers, up to 3 rounds  
- **depth 3**: Ultra mode - 5 researchers, up to 5 rounds

Omit depth for quick mode, or specify higher values for more comprehensive research.

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

pi-research reads `process.env` at startup. The extension does not automatically load `.env` files.

**Use shell environment variables**
```bash
export STACKEXCHANGE_API_KEY=your_key_here
export PI_RESEARCH_VERBOSE=1
pi
```

**Use direnv (recommended)**
```bash
# Create .envrc from example
cp .env.example .envrc

# Edit .envrc with your settings
echo 'export STACKEXCHANGE_API_KEY=your_key_here' >> .envrc

# Enable direnv in this directory
direnv allow
```

Note: Use `.envrc` for direnv (not `.env`). Direnv automatically loads variables when you `cd` into the directory.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | - | Proxy URL for SearXNG (e.g., `socks5://127.0.0.1:9050`) |
| `PI_RESEARCH_RESEARCHER_TIMEOUT_MS` | `240000` | Per-researcher timeout (30s–10m) |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `15000` | SearXNG health check timeout |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `10` | Terminal UI refresh debounce (ms) |
| `PI_RESEARCH_VERBOSE` | - | Enable diagnostic JSONL logging |
| `DOCKER_SOCKET` | platform default | Docker socket path override |
| `DOCKER_HOST` | - | Docker host URL override |
| `STACKEXCHANGE_API_KEY` | - | Stack Exchange API key for higher rate limits |

**Verbose diagnostics**

Set `PI_RESEARCH_VERBOSE=1` to enable JSONL logs in your temp directory. Without this, no log files are created.

### Terminal UI

Real-time progress tracking shows SearXNG status and researcher progress:

```
── Research ───────────────────────────────────────────
┌────────┬───────────────────────────────────────────┬┐
│active  │ 1 ───  2 ───  3 ───  4 ───  5 ───  6 ───+1│
│:55732  │ 2.3k  │ 3.1k  │ 0.8k  │ 1.2k  │ 0.5k  │   │
└────────┴───────────────────────────────────────────┴┘
```

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

Release flow:

```bash
npm version patch  # or minor/major
git push origin main
git push origin v0.1.1
```

Publishing is automated via GitHub Actions when you push a version-matching tag (e.g., `v0.1.1` for `package.json` version `0.1.1`). CI runs lint, type-check, and unit tests before publishing to npm as `@lincolndeen/pi-research` and creating a GitHub Release.

### Dependencies

Docker must be installed separately. npm dependencies are installed automatically.

- `playwright` - Chromium browser for scraping
- `dockerode` - Docker API for SearXNG management
- `@kreuzberg/html-to-markdown-node` and `node-html-markdown` - HTML to Markdown conversion

Publishing as `@lincolndeen/pi-research` on npm.
