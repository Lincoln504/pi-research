# Architecture

This document describes the technical design, orchestration logic, and infrastructure of `pi-research`.

## Orchestration Overview

The project uses a decentralized multi-agent architecture to perform deep web research. It operates in two primary modes: **Quick Mode** and **Deep Mode**.

### Quick Mode
Directly routes research tasks to a single researcher session. This mode avoids the overhead of coordination and evaluation, making it suitable for focused queries. A single researcher has a fixed budget of:
- **4 Gathering calls**: Shared across `search`, `security_search`, `stackexchange`, and `grep`.
- **4 Scrape calls**: Dedicated to full-page content extraction.

### Deep Mode
Uses a state machine to manage a multi-phase research lifecycle:

1.  **Planning Phase**: The AI coordinator analyzes the conversation context and generates a JSON-formatted research agenda—an exhaustive list of tasks required to answer the query.
2.  **Research Phase**: Researchers run in parallel (up to 3 concurrent). Each researcher is assigned a task from the agenda. Findings from completed researchers are injected into the context of researchers starting later in the same round to ensure continuity.
3.  **Evaluation Phase**: The last researcher to complete a round is promoted to **Lead Evaluator**. It compares all gathered findings against the original agenda.
4.  **Synthesis Phase**: If the evaluator determines the research is complete, it synthesizes a final Markdown report. If gaps remain and the round budget allows, it delegates new, targeted queries for a subsequent research round.

State transitions are managed by a pure reducer (`src/orchestration/deep-research-reducer.ts`), ensuring predictable behavior and allowing research sessions to be persisted and resumed.

---

## Component Details

### Research Tools & Limits
Each researcher session is constrained by a `ToolUsageTracker` to prevent infinite loops and manage token consumption:
- **search**: Interfaces with the local SearXNG instance. Supports multiple queries per call.
- **scrape**: Multi-batch protocol for page extraction.
- **security_search**: Queries NVD, CISA KEV, GitHub Advisories, and OSV.
- **stackexchange**: Queries the Stack Exchange network (Stack Overflow, etc.).
- **grep**: Local codebase search using `ripgrep` (fallback to `grep`).

### Context-Aware Scraping Protocol
To avoid exceeding LLM context windows, the `scrape` tool follows a four-step handshake:
1.  **Handshake**: The researcher identifies target URLs. The tool returns a list of URLs already scraped by siblings.
2.  **Batch 1-3**: Sequential scraping of new URLs. 
Scraping is automatically suspended if the current session token count exceeds 55% of the model's context window.

### Shared Link Deduplication
Researchers share a global URL pool within a single pi session. This prevents redundant network requests and ensures that if Sibling A scrapes a page, Sibling B can access the findings without re-scraping.

### SearXNG Lifecycle Management
SearXNG runs as a Docker container (`searxng/searxng:latest`).
- **Lazy Initialization**: The container starts only upon the first research request.
- **Singleton Pattern**: A single container is shared across all research sessions in a pi process.
- **Configuration**: Runtime settings (proxies, API keys) are generated dynamically and volume-mounted into the container.
- **Cross-Session Persistence**: Container state and locking are managed via `~/.pi/state/searxng-singleton.json` to handle multiple concurrent pi processes.

### Evaluator Decision Framework
The Lead Evaluator follows a strict priority list:
1.  Check for fatal errors across all researchers.
2.  Assess coverage against the initial agenda.
3.  Check the round budget (`targetRounds + MAX_EXTRA_ROUNDS`).
Delegation is performed via a structured JSON response; any other output is treated as a final synthesis to prevent stuck states.

---

## Project Structure

- `src/orchestration/`: Core state machine, coordinator, and evaluator logic.
- `src/infrastructure/`: Docker container management and SearXNG lifecycle.
- `src/tools/`: Implementations for search, scraping, and specialized database queries.
- `src/tui/`: Real-time terminal UI components using `pi`'s display capabilities.
- `src/utils/`: Shared utilities for token tracking, JSON extraction, and link deduplication.
- `prompts/`: Markdown-based system instructions for the Coordinator, Researcher, and Evaluator.
- `config/`: Default SearXNG engine and rate-limiter configurations.
