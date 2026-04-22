# Architecture

## Orchestration Modes

Two primary modes: **Quick Mode** and **Deep Mode**.

### Quick Mode
Routes research tasks to a single **Agent Researcher** session. No coordination or evaluation overhead — suitable for focused queries.

### Deep Mode
Uses a state machine to manage a three-status research lifecycle:

1.  **Planning Status**: The AI coordinator analyzes the conversation context and generates a JSON-formatted research agenda—a list of high-level research tasks.
2.  **Researching Status**: 
    - **Parallel Execution**: **Agent Researchers** run in parallel (up to 3 concurrent). Each researcher handles one agenda task per round.
    - **Report Injection**: Collective knowledge is managed by the orchestrator. When a researcher completes its task, its full report (up to 50k chars) is **injected** into the context of siblings starting later, or **steered** into already running ones. This ensures researchers don't just know *what* was scraped, but also *what was found*.
    - **Lead Evaluation**: When a round is complete, a **Lead Evaluator** agent call is triggered. It reviews all accumulated findings against the original agenda.
    - **Decision Outcome**: The evaluator makes a binary choice:
        - **Synthesize**: Generate a final, exhaustive Markdown report (transition to **Completed**).
        - **Delegate**: Formulate new, targeted queries for a subsequent round (remain in **Researching**).
3.  **Completed Status**: The final synthesis is returned as the tool result.

State transitions are managed by a pure reducer (`src/orchestration/deep-research-reducer.ts`), ensuring predictable behavior.

---

## The Agent Researcher

An **Agent Researcher** is the fundamental building block of `pi-research`. Regardless of the orchestration mode, every researcher follows a structured three-phase internal lifecycle:

### Phase 1: Gathering
The researcher uses broad tools to discover relevant information and identify high-quality URLs for further investigation.
- **Budget**: 4 Gathering calls (shared across `search`, `security_search`, `stackexchange`, and `grep`).
- **Goal**: Breadth-first exploration and URL discovery.

### Phase 2: Scraping
The researcher deep-dives into the URLs identified during the Gathering phase to extract detailed content.
- **Budget**: 3 Scrape calls (Batch 1, Batch 2, Batch 3).
- **Goal**: Depth-first extraction of specific data and evidence.
- **Deduplication**: Researchers check a shared URL pool to avoid re-scraping links already handled by siblings. Shared links are injected into the system prompt at session creation and updated in real-time as siblings scrape new URLs.

### Phase 3: Reporting
The researcher synthesizes its individual findings into a structured Markdown report.
- **Structure**: Includes an executive summary, key findings, and a list of cited links.
- **Signaling**: Once finished, the report is submitted to the orchestrator for injection into siblings (Deep Mode) or final return (Quick Mode).

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
To avoid exceeding LLM context windows, the `scrape` tool follows a three-batch protocol. **Each batch step is gated by a 55% context check** — if the session token count already exceeds 55% of the model's context window, that batch is skipped entirely and the tool returns early.

1. **Batch 1**: Up to 3 URLs — primary broad scraping.
2. **Batch 2**: Up to 2 URLs — targeted follow-up, deduplicated against Batch 1.
3. **Batch 3**: Up to 3 URLs — deep-dive scraping.

Shared links are injected into the researcher's system prompt at session creation time and updated in real-time via lightweight `session.steer()` messages when siblings scrape new URLs.

### Shared Link Deduplication
Researchers share a URL pool per research operation. Shared links are injected into the system prompt at session creation and updated in real-time via lightweight messages when siblings scrape new URLs. The pool tracks URLs only — findings are shared separately via Report Injection. It resets for each new query.

### SearXNG Lifecycle Management
SearXNG runs as a Docker container (`searxng/searxng`, tag controlled by `SEARXNG_IMAGE_TAG`, default `latest`).
- **Lazy Initialization**: The container starts only upon the first research request.
- **Singleton Pattern**: A single container is shared across all pi processes on the machine. State is persisted to `~/.pi/state/searxng-singleton.json`; each pi process registers a session by PID and the container stays alive until all registered processes have exited.
- **Configuration**: Runtime settings (proxies, API keys) are generated dynamically and volume-mounted into the container.
- **Engine configuration**: Active search engines are defined in `config/searxng/default-settings.yml`. Engines can be enabled or disabled by editing that file before starting the container.
- **Cross-Session Persistence**: Container state and locking are managed via `~/.pi/state/searxng-singleton.json` to handle multiple concurrent pi processes.

### Output File Location

When research completes, the report is written to a `.md` file named `pi-research-{sanitized-query}-{hash}.md` (e.g. `pi-research-rust-async-runtimes-a3.md`). The destination directory is resolved from the pi session's working directory (`cwd`) using a three-tier priority:

1. **cwd is home or a system directory** → `os.tmpdir()`. Prevents cluttering `~`, drive roots, or system paths like `/usr`.
2. **cwd contains a recognised subdirectory** → that subdirectory. Probed in priority order: `research`, `docs`, `doc`, `ref`, `references`, `notes`. Matching is case-insensitive so it works on macOS APFS and Windows NTFS.
3. **Otherwise** → cwd itself.

The two-character hash suffix (`{letter}{digit}`, e.g. `b7`) is a collision guard — the file is opened with an exclusive-create flag and the hash is regenerated on `EEXIST`. The full saved path is appended as a footer in the report and returned to the pi UI.

### TUI Progress Percentage

The header percentage (`Research: 70%`) tracks tool-call units completed against a budget established after planning. The budget is set from the number of agenda items the coordinator produces — which scales with query complexity (complexity 1 → 2 initial researchers, 2 → 3, 3 → 5), each researcher allocated 10 units. The budget expands dynamically when the evaluator delegates additional rounds. If research goes beyond the planned rounds the display switches to `exploring` instead of a percentage.

### Evaluator Decision Framework
The Lead Evaluator follows a strict priority list:
1.  **Error Check**: If all researchers in a round failed, it reports a critical failure and stops.
2.  **Coverage Check**: It compares cumulative findings against the initial agenda items.
3.  **Round Budget**: It checks the round budget (`targetRounds + MAX_EXTRA_ROUNDS`). The hard limit is `targetRounds + 2` bonus rounds.
4.  **Action Selection**: Produces either a Markdown synthesis (final result) or a JSON delegation object (`{"action": "delegate", "queries": [...]}`). Any non-JSON response is treated as a final synthesis to prevent the research from getting stuck.

---

## Project Structure

- `src/orchestration/`: Core state machine, coordinator, and evaluator logic.
- `src/infrastructure/`: Docker container management and SearXNG lifecycle.
- `src/tools/`: Implementations for search, scraping, and specialized database queries.
- `src/tui/`: Real-time terminal UI components using `pi`'s display capabilities.
- `src/utils/`: Shared utilities for token tracking, JSON extraction, and link deduplication.
- `src/prompts/`: Markdown-based system instructions for the Coordinator, Researcher, and Evaluator.
- `config/`: Default SearXNG engine and rate-limiter configurations.
