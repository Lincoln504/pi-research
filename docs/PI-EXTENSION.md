# Pi Extension

pi-research integrates as a [pi](https://github.com/badlogic/pi-mono)
extension (`src/index.ts`) — a multi-agent web research engine with a real-time
TUI, registered directly in the pi process.

## Usage

The `research` tool is auto-registered, so the model invokes it
from natural language and picks the depth (1–3) itself based on the query.

```bash
pi -p "research the latest developments in WebAssembly"
pi -p "do a thorough deep-dive on the AI inference hardware landscape"
```

Two slash commands are also registered:

| Command | Description |
|---------|-------------|
| `/research <query>` | Runs at the configured default depth (`PI_RESEARCH_DEFAULT_RESEARCH_DEPTH`, 1 by default). It does not parse an inline depth — the model chooses depth when it calls the tool itself. |
| `/research-config` | Opens the interactive TUI settings dashboard. |

## Tools

The extension registers three tools:

| Tool | Registered |
|------|-----------|
| `research` | always |
| `health` | always |
| `research_knowledge_search` | only when `PI_RESEARCH_KNOWLEDGE_STORE_MODE !== 'none'` |

Tool exclusion — the `research` tool honors an `excludeTools` list taken from
the pi session context when the host forwards one.

## TUI

During a run pi-research renders a live progress panel:

- Researcher slices — one per agent: status, URLs scraped, actions taken.
- Wave animation — active-crawl indicator.
- Token usage — model tokens + estimated cost (non-decreasing guard).
- Status flashes — green on success, red on failure.
- Steering messages — queued and active mid-run user guidance.

| Key | Action |
|-----|--------|
| `Escape` | Cancel active research |
| Arrow keys | Navigate the `/research-config` menu |
| `Enter` / `Space` | Cycle a setting's value |

## Configuration

Manage settings through `/research-config`, which edits two layers:

- Global — base `~/.pi/research/config.env` (applies to all front-ends).
- Project — the centralized registry (`~/.pi/research/state/project-settings.json`),
  scoped per working directory. Only depth and knowledge-store mode are
  project-scoped, so a given repo can carry its own research depth without
  changing your global default.

To configure the pi extension independently of the other front-ends, add an
optional overlay at `~/.pi/research/pi.env` (it layers over `config.env` for the
pi extension only). The full configuration model, precedence, and the complete
environment-variable list live in [CONFIGURATION.md](CONFIGURATION.md).

## Coding-agent skill installer

The `/research-config` menu can install the `pi-research` skill into your other
coding agents (Claude, Codex, OpenClaw) so they can run web research through the
CLI, and remove it again — with exact, manifest-tracked cleanup. See
[AGENT-SKILL.md](AGENT-SKILL.md) for the full installation flow.

## Lifecycle

- `activate` — registers commands, tools, the TUI controller, and initializes services.
- `deactivate` — drains the writer queue, closes LanceDB, terminates the browser pool, disposes the embedding model.
- `session_shutdown` — branches on `event.reason`: a `quit` triggers process-exit cleanup; reload / new / resume / fork clean up without exiting.

Extension state is isolated per pi session, so `/reload` is safe.
