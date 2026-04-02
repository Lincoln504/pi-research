# pi-research Extension

A pi coding agent extension that orchestrates multi-agent research using a coordinator + parallel/sequential researcher architecture.

## Features

- **Multi-Agent Orchestration**: Coordinator agent breaks down queries into research slices and delegates to specialized researchers
- **Parallel/Sequential Execution**: Researchers can run simultaneously or sequentially based on coordinator's decision
- **Web Research**: Uses pi-search-scrape tools for web search, URL scraping, and security database queries
- **Code Search**: Includes ripgrep (rg) or grep fallback for codebase searches
- **Visual Progress**: TUI panel shows SearXNG connection status, token usage, and active researchers with flash effects
- **SearXNG Management**: Takes ownership of Docker SearXNG container lifecycle from pi-search-scrape
- **Optional Tor Proxy**: Route searches through Tor to avoid IP blocking (see [TOR.md](./TOR.md))

## Quick Setup

### Automatic Setup

Run the setup script to configure symlinks:

```bash
~/Documents/pi-research/setup-symlinks.sh
```

This script will:
1. Ensure pi-research symlink exists
2. Prompt you to enable or disable pi-search-scrape
3. Show current symlink configuration

### Quick Toggle

To quickly toggle pi-search-scrape on/off:

```bash
# Toggle (current state flips)
~/Documents/pi-research/toggle-search-scrape.sh

# Explicit enable
~/Documents/pi-research/toggle-search-scrape.sh on

# Explicit disable
~/Documents/pi-research/toggle-search-scrape.sh off
```

### Manual Setup

```bash
# Create symlink for pi-research
ln -s ~/Documents/pi-research ~/.pi/agent/extensions/pi-research

# Optionally add pi-search-scrape (if you want both extensions)
ln -s ~/Documents/pi-search-scrape ~/.pi/agent/extensions/pi-search-scrape
```

## Configuration Modes

### Mode 1: pi-research Standalone (Recommended for Testing)

- **pi-research**: ENABLED
- **pi-search-scrape**: DISABLED
- **SearXNG**: Managed by pi-research via `SEARXNG_EXTERNAL_MANAGED=true`

This is the default setup after running `setup-symlinks.sh` and choosing option 1.

### Mode 2: Both Extensions

- **pi-research**: ENABLED
- **pi-search-scrape**: ENABLED
- **SearXNG**: pi-search-scrape manages its own instance (ignores `SEARXNG_EXTERNAL_MANAGED`)

Use this mode if you want to use both research and search/scrape tools independently.

## Usage

### Start pi

```bash
pi
```

pi will automatically load extensions from `~/.pi/agent/extensions/`.

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
- `Investigate the history of open source software`

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
6. **src/agent-tools.ts**: Tool wrappers for pi-search-scrape functions
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

# Enable Tor proxy for SearXNG searches (default: disabled)
export PI_RESEARCH_ENABLE_TOR=true

# Tor SOCKS5 port (default: 9050)
export PI_RESEARCH_TOR_SOCKS_PORT=9050

# Tor control port (default: 9051)
export PI_RESEARCH_TOR_CONTROL_PORT=9051

# Auto-start Tor if not running (default: false)
export PI_RESEARCH_TOR_AUTO_START=true

> **Note:** Tor support is optional and requires Tor to be installed. See [TOR.md](./TOR.md) for detailed setup instructions.

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
- `pi-search-scrape`: Imported via relative path for web research tools

## Integration with pi-search-scrape

The extension adds guards to pi-search-scrape's lifecycle management:

```typescript
// In pi-search-scrape/index.ts
if (process.env.SEARXNG_EXTERNAL_MANAGED === 'true') {
  // Skip SearXNG lifecycle - pi-research manages it
  return;
}
```

This allows pi-search-scrape to run standalone while pi-research takes ownership when active.

## Development

```bash
cd ~/Documents/pi-research

# Install dependencies
npm install

# Test TypeScript compilation
npx tsc --noEmit --skipLibCheck

# Load extension with pi (manual)
pi -e ./index.ts

# Or use auto-discovery via symlink (recommended)
# Run setup script:
~/Documents/pi-research/setup-symlinks.sh
```

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
- [ ] pi-search-scrape works standalone when symlink is removed

## Troubleshooting

### Extension doesn't load

Check symlink:
```bash
ls -l ~/.pi/agent/extensions/pi-research
```

Should point to `~/Documents/pi-research`.

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

## License

Private extension for personal use.
