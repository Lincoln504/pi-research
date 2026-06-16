# pi-research — Pi Extension Guide

pi-research integrates as a first-class [pi extension](https://github.com/badlogic/pi-mono), registering a multi-agent web research engine with real-time TUI.

## Commands

| Command | Description |
|---------|-------------|
| `/research <query>` | Run research at the configured default depth (1–3) |
| `/research-config` | Open the interactive TUI configuration dashboard |

The `research` tool is also auto-registered at startup — the LLM can invoke it directly without a slash command. Just ask pi to "research X" and it will use the tool.

## TUI Integration

During research, pi-research renders a live progress panel with:

- **Researcher slices** — one per agent, showing status, URLs scraped, and actions taken
- **Wave animation** — visual indicator of active crawling
- **Token usage** — model token consumption and estimated cost (non-decreasing guard)
- **Per-researcher status flashes** — green for success, red for failures
- **Steering messages** — queued and active user guidance injected mid-research

### Keybindings

| Key | Action |
|-----|--------|
| `Escape` | Cancel active research |
| Arrow keys | Navigate configuration menu |
| `Enter` / `Space` | Cycle setting values in `/research-config` |

## Configuration

All settings are managed through the `/research-config` TUI dashboard. It presents a scrollable list with:

- **Global settings** — saved to `~/.pi/research/config.env`
- **Project settings** — stored in the Centralized Registry (`~/.pi/state/project-settings.json`), overriding global defaults per directory

Key categories:

| Category | Settings |
|----------|----------|
| **Research** | Timeout, max researchers, default depth, scrape batches, model override |
| **Browser** | Worker thread count and concurrency are environment-only (`PI_RESEARCH_WORKER_THREADS`, default 4; `PI_RESEARCH_WORKER_CONCURRENCY`). Transient browser profiles default to disk (`~/.cache/pi-research/profiles`) rather than the system temp dir, so a RAM-backed `/tmp` (tmpfs) is not consumed; override with `PI_RESEARCH_TMP_DIR` |
| **Knowledge Store** | Store mode (none/project/global), embedding model, device |
| **Reporting** | Export enable, debug logging |
| **Actions** | Clear store scopes, view database/memory status, view metrics |

See [SDK.md](SDK.md) for the full environment variable reference.

## How It Works

1. **Startup** — pi-research registers the `research` tool, `/research` command, `/research-config` command, and initializes the SDK.
2. **Research** — The deep research orchestrator plans parallel researcher tracks, each running in isolation with web tools (search, scrape, security databases, Stack Exchange).
3. **Evaluation** — An AI evaluator reviews findings after each round and either synthesizes a final report or launches deeper investigation.
4. **Knowledge Store** — Scraped content is embedded and stored in a local LanceDB vector database for cross-session retrieval via `research_knowledge_search`.
5. **TUI** — Real-time progress is rendered via pi's TUI API using `SettingsList`, custom widgets, and event-driven state updates.
6. **Shutdown** — On dispose, all browser workers, embedding models, and database connections are cleaned up.

## Extension Lifecycle

- `activate` — registers commands, tools (`research`, `health`, `research_knowledge_search`), TUI controller, and initializes the SDK
- `deactivate` — runs all shutdown cleanup tasks: drains the writer queue, closes LanceDB, terminates browser pool workers, and disposes the embedding model
- `session_shutdown` — branches on `event.reason`: a `quit` event triggers process-exit cleanup; reload/new/resume/fork events run cleanup without forcing process exit
- `/reload` support — extension state is isolated per pi session
