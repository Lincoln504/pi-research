# Architecture

This document describes the technical design, orchestration logic, and infrastructure of `pi-research`.

## Orchestration Overview

The project uses a decentralized multi-agent architecture to perform deep web research. It operates in two primary modes: **Quick Mode** and **Deep Mode**.

### Quick Mode
Directly routes research tasks to a single researcher session. This mode avoids the overhead of coordination and evaluation, making it suitable for focused queries. A single researcher has a fixed budget of:
- **4 Gathering calls**: Shared across `search`, `security_search`, `stackexchange`, and `grep`.
- **4 Scrape calls**: Dedicated to full-page content extraction.

### Deep Mode
Uses a state machine to manage a three-status research lifecycle:

1.  **Planning Status**: The AI coordinator analyzes the conversation context and generates a JSON-formatted research agenda—a list of high-level research tasks.
2.  **Researching Status**: 
    - **Parallel Execution**: Researchers run in parallel (up to 3 concurrent). Each researcher handles one agenda task per round.
    - **Report Injection**: Findings from completed researchers are injected into the context of researchers starting later in the same round, or "steered" into already running ones, to ensure continuity.
    - **Lead Evaluation**: When a round is complete, a **Lead Evaluator** agent call is triggered. It reviews all accumulated findings against the original agenda.
    - **Decision Outcome**: The evaluator makes a binary choice:
        - **Synthesize**: Generate a final, exhaustive Markdown report (transition to **Completed**).
        - **Delegate**: Formulate new, targeted queries for a subsequent round (remain in **Researching**).
3.  **Completed Status**: The final synthesis is returned as the tool result.

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
2.  **Batch 1**: Up to 3 URLs — primary broad scraping.
3.  **Batch 2**: Up to 2 URLs — targeted follow-up (deduplicated against Batch 1).
4.  **Batch 3**: Up to 3 URLs — deep-dive scraping.
Scraping is automatically suspended if the current session token count exceeds 55% of the model's context window.

### Shared Link Deduplication
Researchers share a URL pool within a single research operation (one `pi-research` call). This prevents redundant network requests by signaling which links are currently being or have already been scraped by siblings. When a researcher completes their task, their full report (including findings from these links) is injected into the context of other siblings to ensure collective knowledge without redundant scraping. The pool is reset for each new, unique research query to maintain context relevance and avoid window bloat.

### SearXNG Lifecycle Management
SearXNG runs as a Docker container (`searxng/searxng:latest`).
- **Lazy Initialization**: The container starts only upon the first research request.
- **Singleton Pattern**: A single container is shared across all research sessions in a pi process.
- **Configuration**: Runtime settings (proxies, API keys) are generated dynamically and volume-mounted into the container.
- **Cross-Session Persistence**: Container state and locking are managed via `~/.pi/state/searxng-singleton.json` to handle multiple concurrent pi processes.

### Evaluator Decision Framework
The Lead Evaluator follows a strict priority list:
1.  **Error Check**: If all researchers in a round failed, it reports a critical failure and stops.
2.  **Coverage Check**: It compares cumulative findings against the initial agenda items.
3.  **Round Budget**: It checks the round budget (`targetRounds + MAX_EXTRA_ROUNDS`). The hard limit is `targetRounds + 2` bonus rounds.
4.  **Action Selection**: It produces either a Markdown synthesis (Final Result) or a JSON delegation object (`{"action": "delegate", "queries": [...]}`).
Any non-JSON response from the model is treated as a final synthesis to prevent research from becoming "stuck."

---

## Project Structure

- `src/orchestration/`: Core state machine, coordinator, and evaluator logic.
- `src/infrastructure/`: Docker container management and SearXNG lifecycle.
- `src/tools/`: Implementations for search, scraping, and specialized database queries.
- `src/tui/`: Real-time terminal UI components using `pi`'s display capabilities.
- `src/utils/`: Shared utilities for token tracking, JSON extraction, and link deduplication.
- `prompts/`: Markdown-based system instructions for the Coordinator, Researcher, and Evaluator.
- `config/`: Default SearXNG engine and rate-limiter configurations.
