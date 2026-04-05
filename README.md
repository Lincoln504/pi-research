# pi-research

![pi-research banner](README-banner.jpg)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/pi-research.svg)](https://www.npmjs.com/package/pi-research)
[![CI Status](https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml/badge.svg)](https://github.com/Lincoln504/pi-research/actions/workflows/ci.yml)

**Multi-agent research orchestration** for pi. Supports both single-agent research and multi-agent research with a coordinator that delegates parallel/sequential researchers, then synthesizes findings into comprehensive answers.

## Core Capabilities

- **Single Research** (`depth: "quick"`) - Single researcher for fast, focused queries
- **Multi-Agent Research** (`depth: "deep"`, default) - Coordinator delegates to parallel researchers for comprehensive coverage
- **Web Search** via SearXNG with Docker container management
- **URL Scraping** with 2-layer architecture (fetch → Playwright fallback)
- **Security Search** via NVD, CISA KEV, GitHub, OSV databases
- **Stack Exchange API** integration for technical answers
- **Code Search** using ripgrep (rg) with grep fallback
- **Visual TUI** progress tracking showing active researchers and slices
- **Proxy Support** for Tor or HTTP proxy connections

## Quick Start

```bash
# Install
npm install -g pi-research

# Or from GitHub
npm install -g https://github.com/Lincoln504/pi-research-dev.git

# Run
pi research "query here"
```

## Usage Examples

### Single Agent Research

```bash
# Single researcher for quick, focused research
pi research "What is a binary search tree?"

# Deep multi-agent research with coordinator
pi research "complex query" --depth deep
```

### Multi-Agent Research with Coordinator

```bash
# Deep multi-agent research with coordinator
pi research "complex query" --depth deep

# Deep multi-agent research with explicit mode
pi research "complex query" --mode deep

# Deep multi-agent research with model selection
pi research "complex query" --depth deep --model gem-3

# Deep multi-agent research with parallel execution
pi research "complex query" --mode deep --parallel
```

### Programmatic Usage

```python
from pi_research import research

result = research("binary search tree")
print(result.answer)
```

## Configuration

Copy the example configuration file:

```bash
cp .env.example .env
```

Edit `.env` to set options:

```bash
# Researcher timeout (default: 240000ms / 4 minutes)
PI_RESEARCH_RESEARCHER_TIMEOUT_MS=240000

# Flash duration for TUI (default: 1000ms)
PI_RESEARCH_FLASH_TIMEOUT_MS=1000

# TUI mode (simple or full)
PI_RESEARCH_TUI_MODE=simple

# Proxy URL (optional)
PROXY_URL=socks5://127.0.0.1:9050
```

Source the configuration:

```bash
source .env
pi research "query here"
```

## Quick Reference

| Option | Description | Default |
|--------|-------------|---------|
| `depth` | Research depth | "deep" |
| `mode` | Research mode (deep/quick) | "deep" |
| `model` | Model ID for agents | current active model |
| `parallel` | Execution mode | parallel |

## TUI Modes

### Simple Mode

Shows active researcher status with current token consumption.

```bash
PI_RESEARCH_TUI_MODE=simple
```

### Full Mode

Shows full research coordinator with all slices and their progress.

```bash
PI_RESEARCH_TUI_MODE=full
```

## Proxy Support

For Tor or HTTP proxy support, configure in `.env`:

```bash
# Tor
PROXY_URL=socks5://127.0.0.1:9050

# HTTP proxy
PROXY_URL=http://proxy.example.com:8080

# Authenticated proxy
PROXY_URL=http://user:pass@proxy.example.com:8080
```

See `TOR.md` for detailed Tor setup instructions.

## Dependencies

- `@mariozechner/pi-coding-agent`: pi core SDK
- `@sinclair/typebox`: Parameter schema validation
- `@kreuzberg/html-to-markdown-node`: HTML to Markdown conversion
- `dockerode`: Docker API client
- `js-yaml`: YAML parsing
- `playwright`: Headless browser for JS-heavy scraping

## Development

```bash
cd ~/Documents/pi-research

# Install dependencies
npm install

# Type checking
npx tsc --noEmit

# Linting
npm run lint

# Run tests
npm test
```

## License

MIT