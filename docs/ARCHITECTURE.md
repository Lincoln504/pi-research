# Architecture

## Orchestration Modes

Two primary modes: **Quick Mode** and **Deep Mode**.

### Quick Mode
Routes research tasks to a single **Agent Researcher** session. No coordination or evaluation overhead — suitable for focused queries.

### Deep Mode
Uses a multi-agent workflow to manage a research lifecycle:

1.  **Planning Phase**: The AI coordinator generates a JSON-formatted research agenda—a list of specialized researchers and an exhaustive set of search queries.
2.  **Search Burst**: Before researchers spawn, a massive search burst (up to 150 queries) is executed across a multi-threaded worker pool to pre-seed the global link pool.
3.  **Research Phase**: 
    - **Parallel Execution**: **Agent Researchers** run in parallel (up to 3 concurrent). Each researcher handles one specialized aspect.
    - **Real-Time Coordination**: Collective knowledge is managed by the orchestrator. Scraped links are shared between siblings in real-time via steering messages.
    - **Completion Summary**: When a researcher finishes, a summary of its findings is broadcast to all active siblings.
4.  **Evaluation Phase**: When a round is complete, a **Lead Evaluator** reviews all findings.
    - **Decision Outcome**: The evaluator choose to either **Synthesize** (generate the final report) or **Delegate** (formulate new, targeted researchers for a subsequent round).

---

## The Agent Researcher

An **Agent Researcher** is the fundamental building block of `pi-research`. Regardless of the orchestration mode, every researcher follows a structured three-phase internal lifecycle:

### Phase 1: Gathering
The researcher uses broad tools to discover relevant information and identify high-quality URLs.
- **Budget**: 4 Gathering calls (shared across `search`, `security_search`, `stackexchange`, and `grep`).
- **Goal**: Breadth-first exploration and URL discovery.

### Phase 2: Scraping
The researcher deep-dives into URLs to extract detailed content.
- **Budget**: 3 Scrape calls (Batch 1, Batch 2, Batch 3).
- **Goal**: Depth-first extraction of specific data and evidence.
- **Deduplication**: Researchers check a shared URL pool to avoid redundant work.

### Phase 3: Reporting
The researcher synthesizes its individual findings into a structured Markdown report.
- **Signaling**: Once finished, the report is submitted to the orchestrator for synthesis or delegation.

---

## Component Details

### Research Tools & Limits
Each researcher session is constrained by a `ToolUsageTracker`:
- **search**: Multi-threaded browser-based search using DuckDuckGo Lite.
- **scrape**: Multi-batch protocol for page extraction using stealth browser.
- **security_search**: Queries NVD, CISA KEV, GitHub Advisories, and OSV.
- **stackexchange**: Queries the Stack Exchange network.
- **grep**: Local codebase search using `ripgrep`.

### Context-Aware Scraping Protocol
To avoid exceeding LLM context windows, the `scrape` tool follows a three-batch protocol. **Each batch is gated by a context window check** (threshold: 55%).

1. **Batch 1**: Up to 4 URLs — primary broad scraping.
2. **Batch 2**: Up to 3 URLs — targeted follow-up.
3. **Batch 3**: Up to 3 URLs — deep-dive scraping.

### Browser Infrastructure
`pi-research` uses a unified task scheduler for all browser-based operations:
1.  **Unified Pool**: A `FixedThreadPool` (Poolifier) manages 3 worker processes that handle **Search**, **Scraping**, and **Health Checks**. Each worker maintains a "warm" `camoufox` (stealth Firefox) instance.
2.  **Resource Caps**: By using a single shared pool, the system strictly limits the total number of browser processes to 3 globally, preventing system overload regardless of the number of active PI sessions.
3.  **Stealth Engine**: `camoufox-js` provides advanced fingerprinting protection to bypass automated request detection.
4.  **Health Check**: The system performs a "Start + Every 20" search health check strategy, offloaded to the worker pool, to detect IP blocks or network failures.

### Output File Location
Research reports are saved as Markdown files with a collision-guarded naming scheme: `pi-research-{sanitized-query}-{hash}.md`. The destination is resolved based on the session's working directory, prioritizing `research/` or `docs/` subdirectories if they exist.

---

## Project Structure

- `src/orchestration/`: Multi-agent coordination and evaluation logic.
- `src/infrastructure/`: Browser management, thread pooling, and singleton state.
- `src/tools/`: Implementation of the research tool suite.
- `src/web-research/`: Stealth search and scraping layers.
- `src/tui/`: Terminal UI for real-time progress tracking.
- `src/prompts/`: System instructions for the various agent roles.
