# pi-research Extension

A pi coding agent extension that orchestrates multi-agent research using a coordinator + parallel/sequential researcher architecture.

## Features

- **Multi-Agent Orchestration**: Coordinator agent breaks down queries into research slices and delegates to specialized researchers
- **Parallel/Sequential Execution**: Researchers can run simultaneously or sequentially based on coordinator's decision
72|- **Web Research**: Built-in tools for web search, URL scraping, and security database queries (via SearXNG)
- **Code Search**: Includes ripgrep (rg) or grep fallback for codebase searches
- **Visual Progress**: TUI panel shows SearXNG connection status, token usage, and active researchers with flash effects
- **SearXNG Management**: Manages Docker SearXNG container lifecycle for web searches
- **Optional Proxy Support**: Route searches through Tor or HTTP proxy to avoid IP blocking (see [TOR.md](./TOR.md))

## Quick Setup

### Installation

Install as a pi extension via npm or GitHub:

```bash
# Install from npm
npm install -g pi-research

# Or install from GitHub
npm install -g https://github.com/your-org/pi-research.git

# Or from local directory (development)
cd ~/Documents/pi-research
npm install
pi -e ./index.ts
```

The extension will automatically be available in pi after installation.


## Usage

### Start pi

```bash
pi
```

pi will automatically load the extension.

### Use the Research Tool

```
Please research: What is a binary search tree?
```

Or from the agent:

```python
research("history of the internet")
```

### Example Queries

- `Research: quantum computing applications`
- `Find information about recent developments in AI`
- `Investigate history of open source software`

## Architecture

```
Query → Coordinator Agent → Researcher Agents (pi_search, pi_scrape, pi_security_search, rg_grep)
                              ↓
                        Results Synthesis
                              ↓
                        Final Answer
```

### Components

1. **coordinator.md**: System prompt for coordinator agent
2. **researcher.md**: System prompt for researcher agents
3. **src/tool.ts**: Main orchestration logic and research tool
4. **src/coordinator.ts**: Creates and manages coordinator sessions
5. **src/researcher.ts**: Creates and manages researcher sessions
3a|6. **src/agent-tools.ts**: Creates agent tools for research (web search, scraping, security databases, code search)
7. **src/rg-grep.ts**: Standalone ripgrep/grep tool
8. **src/searxng-lifecycle.ts**: SearXNG container lifecycle management
9. **src/session-context.ts**: Formats parent session context
10. **src/tui/combined-panel.ts**: Combined TUI widget (SearXNG status + research panel)
11. **src/tui/panel.ts**: TUI panel component (legacy reference)

## Research Process

1. **Query Submission**: User provides a research query
2. **Context Gathering**: Last 10 parent messages are formatted for context
3. **SearXNG Start**: Docker container is started if not running
4. **Panel Display**: TUI panel shows connection status, token count, and agents
5. **Coordination**:
   - Coordinator receives context + query
   - **Optional**: If project-related or unclear, delegates to project/context agent:
     - Uses ONLY `read` tool (no search, no scrape, no rg)
     - Scans key project files (package.json, README, main files)
     - Returns brief project context summary
   - **Research Strategy Decision**:
     - Simple: Returns `{"final":"comprehensive answer"}`
     - Complex: Returns `{"slices":["topic1","topic2"],"simultaneous":true/false}`
6. **Research**: Each researcher investigates their slice using available tools
7. **Synthesis**: Coordinator receives results and either:
   - Requests follow-up slices for depth research (labels as 1.1, 1.2, etc.)
   - Provides final answer
8. **Cleanup**: Panel removed, final answer returned

**Max Iterations:** 3 coordinator rounds (prevents infinite research loops)

## Agent Tools

**Coordinator** has access to:
1. **read**: Read project files for context gathering
2. **rg_grep**: Search codebase using ripgrep/grep
3. **pi_search**: Web search via SearXNG
4. **pi_scrape**: URL scraping with 2-layer architecture
5. **pi_security_search**: Security vulnerability database search
6. **pi_stackexchange**: Stack Exchange API search

**Project/Context Agent** (if delegated) has access to:
1. **read** ONLY (no search, no scrape, no rg)

**Researchers** have access to:
1. **read**: Read project files
2. **rg_grep**: Search codebase using ripgrep/grep
3. **pi_search**: Web search via SearXNG
4. **pi_scrape**: URL scraping with 2-layer architecture
5. **pi_security_search**: Security vulnerability database search (NVD, CISA KEV, GitHub, OSV)
6. **pi_stackexchange**: Stack Exchange API search

## TUI Panel

The research extension supports two TUI modes for visualizing research progress:

### Simple Mode (Default)

Compact boxed display using pi's built-in TUI components:

```
┌─ Research Panel ─────────────────────────┐
│ ● active  http://localhost:8080  tk: 10.2k │
│ ● Coordinator  ●1 ●2 ●3              │
└────────────────────────────────────────────┘
```

- **Line 1**: SearXNG connection status + URL + token count
- **Line 2**: Coordinator indicator + agent dots
- **Boxed layout**: Uses pi's Box, Container, Text components for stable rendering

### Full Mode

Sophisticated boxed grid layout showing slice/depth hierarchy:

```
┌─ Research Coordinator ── tk: 42.3k ──────┐
│    1         2         3                │
│   ●●        ●●        ●●               │
│   ○1.1      ○         ○                │
│   ○1.2      ○         ○                │
└──────────────────────────────────────────┘
```

### Configuration

Set TUI mode via environment variable:

```bash
# Simple mode (default)
export PI_RESEARCH_TUI_MODE=simple

# Full mode
export PI_RESEARCH_TUI_MODE=full
```

### Visual Semantics

**Flash Indicators:**
- `●` (green) = Just completed successfully
- `●` (red) = Just completed with error
- `○` (hollow) = Running, idle, or pre-execution
- Flash clears after `PI_RESEARCH_FLASH_TIMEOUT_MS` (default: 500ms)

**Full Mode Layout:**
- Columns = Research slices (side-by-side)
- Rows = Agent depth levels (hierarchical)
- Slice numbers (1, 2, 3) appear as column headers
- Top-level agents show just marker (● or ○)
- Depth agents show full label (1.1, 1.2) stacked under parent slice

For detailed TUI documentation, see [TUI.md](./TUI.md).

### Configuration Options

```bash
# Researcher timeout (default: 60s)
export PI_RESEARCH_RESEARCHER_TIMEOUT_MS=60000

# Flash duration (default: 500ms)
export PI_RESEARCH_FLASH_TIMEOUT_MS=500

# Enable proxy for SearXNG searches (default: disabled)
# Supports SOCKS5 (Tor) or HTTP/HTTPS proxies
# Example: socks5://127.0.0.1:9050 or http://proxy.example.com:8080
export PROXY_URL=socks5://127.0.0.1:9050

> **Note:** Proxy support is optional. See [TOR.md](./TOR.md) for detailed setup instructions.

# TUI mode (default: simple)
export PI_RESEARCH_TUI_MODE=simple|full
```

### Architecture

The TUI implementation uses pi's built-in component system:
- **Box**: Container with padding and borders
- **Container**: Groups child components vertically
- **Text**: Multi-line text with word wrapping
- **Dynamic updates**: `setText()` and `invalidate()` for state changes

This ensures proper spacing, stable rendering, and correct TUI widget positioning.

### Color Coding (Simple Mode)
- `[active]` → Green
- `[error]` → Red
- `[starting]` / `[inactive]` → Muted gray
- Slice numbers → Accent color

Research agents are organized into slices (top-level research topics) and depths (follow-up investigation):

**Top-Level Slices (Iteration 1):**
```
1    2    3
│    │    │
└────┴────┴──> Parallel research on different topics
```

**Depth Agents (Iteration 2+):**
```
1         2         3
│1.1      │         │
│1.2      │         │
└─────┴───┴─┬─────┴─> Deeper investigation into slice 1
```

**Agent ID Format:**
- Top-level: `sliceNumber` (e.g., "1", "2", "3")
- Depth: `sliceNumber.depthNumber` (e.g., "1.1", "1.2", "2.1")

**Visual Representation:**
- Slice numbers (1, 2, 3) appear as column headers
- Top-level agents show just flash marker (● or ○)
- Depth agents show full label (1.1, 1.2) stacked under parent slice

## Token Usage

The TUI panel displays cumulative token usage across all sessions:
- Coordinator: Added to total when assistant messages complete
- Researchers: Added to total as they complete
- Display format: `tk: 12.5k` (k for thousands, M for millions)

## Error Handling

- **Missing model**: Returns error asking user to select a model
- **SearXNG failure**: Returns detailed error message
- **Abort**: Cleanly shuts down all sessions and removes panel
- **Max iterations**: Forces final answer after 3 coordinator rounds

## Dependencies

- `@mariozechner/pi-coding-agent`: pi core SDK
- `@sinclair/typebox`: Parameter schema validation
a4|- `@kreuzberg/html-to-markdown-node`: HTML to Markdown conversion for scraping
b1|- `dockerode`: Docker API client for SearXNG container management
99|- `js-yaml`: YAML parsing for SearXNG settings
95|- `playwright`: Headless browser for JS-heavy web scraping

## Development

```bash
cd ~/Documents/pi-research

# Install dependencies
npm install

# Test TypeScript compilation
npx tsc --noEmit --skipLibCheck

# Load extension with pi (manual)
pi -e ./index.ts
```

## Proxy Configuration

To configure a proxy (Tor or HTTP proxy), use the `.env` file:

```bash
# Copy example
cp .env.example .env

# Edit file
vim .env
# Set: PROXY_URL=socks5://127.0.0.1:9050

# Apply
source .env
pi
```

Or use the setup script:
```bash
./setup-config.sh
```

For detailed proxy setup instructions, see [TOR.md](./TOR.md).

## Testing Checklist

- [ ] Extension loads without errors
- [ ] Research tool is available
- [ ] SearXNG container starts on first research call
- [ ] TUI panel appears with correct layout
- [ ] Coordinator delegates slices correctly
- [ ] Researchers investigate using available tools
- [ ] Token count updates during execution
- [ ] Flash effects work (green/red on tool execution)
- [ ] Final answer is returned after synthesis
- [ ] Abort (Escape) cleanly shuts down sessions
- [ ] Sequential mode works
- [ ] rg_grep tool works with ripgrep/grep fallback

## Troubleshooting

### Extension doesn't load

Check installation:
```bash
npm list -g pi-research
```

Should show pi-research in global packages.

### SearXNG fails to start

Check Docker is running:
```bash
docker ps
docker logs <container-id>
```

### Research tool not available

Check pi output for errors:
```bash
pi -e ./index.ts
```

Look for TypeScript compilation errors or missing dependencies.

### Proxy not working

Verify proxy is running:
```bash
# For Tor
sudo systemctl status tor

# Test proxy
curl --socks5 127.0.0.1:9050 https://check.torproject.org
```

## License

Private extension for personal use.
