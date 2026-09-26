## Pi Extension

pi-research integrates as a [pi](https://github.com/earendil-works/pi)
extension (`src/index.ts`), a multi-agent web research engine with a real-time
TUI registered directly in the pi process.

### Usage

The `research` tool is auto-registered, so the model invokes it
from natural language, and the tool understands the depth needed (1–3) from the query.

```bash
pi -p "research the latest developments in WebAssembly"
pi -p "do a thorough deep-dive on the AI inference hardware landscape"
```

Three slash commands are also registered:

| Command | Description |
|---------|-------------|
| `/research <query>` | Invokes the `research` tool directly at the configured default depth (`PI_RESEARCH_DEFAULT_RESEARCH_DEPTH`, 1 by default) — a plain live run with no LLM turn. It does not parse an inline depth and does **not** consult the knowledge store; use `/knowledge-store <query>` for a store-only lookup. |
| `/research-config` | Opens the interactive TUI settings dashboard. On non-TUI hosts (RPC, web hub, print, JSON, SDK) the menu cannot render, so the command reports why and answers with the headless diagnostics that do work there: `/research-config health` (system health) and `/research-config knowledge-status` (knowledge-store status). |
| `/knowledge-store <query>` | Searches the local knowledge store for a query and returns a synthesised answer from previously researched findings. Unavailable when Knowledge Mode is `none`. The store auto-manages its own compaction, so there is no maintenance subcommand. |

![Running a live investigation with the /research slash command](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/01-slash-research.gif)

### Tools

The extension registers four tools:

| Tool | Registered |
|------|-----------|
| `research` | always |
| `health` | always |
| `research_knowledge_search` | always (see note) |
| `fetch_url` | always; active only when enabled (see below) |

`research_knowledge_search` is registered unconditionally so a Knowledge Mode
change takes effect without restarting pi (pi has no unregister API). When
`PI_RESEARCH_KNOWLEDGE_STORE_MODE` is `none` the tool is not advertised to the
agent — its prompt guidance is stripped, and any call returns a "store disabled"
result; the `/knowledge-store` command is likewise unavailable. Advertisement and
the store's read/write paths are gated on the live mode, not on this registration.

Tool exclusion — the `research` tool honors an `excludeTools` list taken from
the pi session context when the host forwards one.

#### `fetch_url`

Opt-in (`PI_RESEARCH_FETCH_URL_ENABLED`, or **fetch_url tool** in
`/research-config`). Gives the main agent a direct way to read one known URL —
a docs page, a README, an API response, a PDF — without a research run.
Researchers never get it (they keep `scrape`). While disabled the tool is removed
from the session's active tools, so the model never sees it; the toggle applies
from the next agent turn.

- **Fetching.** Plain GET first, the stealth browser when the page needs it
  (`PI_RESEARCH_FETCH_URL_BROWSER_FALLBACK`), with the same connect-time
  private-address blocking as research scrapes. HTTPS only: `http://` is
  upgraded, a redirect to `http:` is refused, and so is a browser page that ends
  on `http:`. The result always names the final URL and the redirect count:
  after an open redirect on a trusted site, the content is from the final host.
  Text-like responses (plain text, Markdown, JSON, CSV, XML, YAML) come back
  verbatim (JSON pretty-printed); HTML and PDFs are converted to Markdown.
- **Paging.** Chunks of `PI_RESEARCH_FETCH_URL_MAX_CHARS` characters (default
  40,000 ≈ 10k tokens; the agent may pass its own `maxChars`), cut at a
  paragraph, never inside a code block when avoidable. The footer gives the
  `start` for the next chunk; the first chunk lists the page's headings with
  offsets. Pages are cached for 10 minutes, so paging never re-downloads and
  every chunk comes from one version of the page.
- **Untrusted framing.** Content sits between `[BEGIN/END UNTRUSTED CONTENT <nonce>]`
  markers with a random per-call nonce (a page cannot fake its own end marker),
  under an untrusted-content banner. Invisible Unicode used to smuggle text to AI
  readers (tag characters, zero-width runs, bidi controls, variation-selector
  runs) is removed, and the count is reported. Heuristic *risk hints* —
  instruction-override phrasing, chat-template markup, tool-call look-alikes,
  exfiltration-shaped links, text hidden from human readers by inline styles —
  are listed with their offsets. They are hints, not verdicts: pages *about* AI
  or security trigger them too.
- **Outbound check.** The request URL itself can carry data out (a query string
  is enough, no request body needed). Before any network activity, a URL with
  long encoded values, secret-shaped tokens (API keys, JWTs, private keys) or an
  unusually long host label is held: `PI_RESEARCH_FETCH_URL_OUTBOUND_CHECK=ask`
  (default) asks you in a dialog (10-minute timeout, refused when no dialog is
  available), `block` refuses, `off` allows.

`fetch_url` is an outbound channel like `curl`: if you restrict the agent's
shell but enable `fetch_url`, the outbound check is what stands between an
injected instruction and a request carrying your data. The untrusted framing and
risk hints lower the chance that a fetched page steers the agent; they are not a
guarantee.

### TUI

During a run pi-research renders a live progress panel:

- Researcher slices — one per agent: status, URLs scraped, actions taken.
- Wave animation — active-crawl indicator.
- Token usage — model tokens + estimated cost (non-decreasing guard).
- Status flashes — green on success, red on failure.
- Steering messages — queued and active mid-run user guidance.

| Key | Action |
|-----|--------|
| `Escape` | Cancel active research |
| `Ctrl+C` | With text in the editor: clears the editor only. With an empty editor: cancels the run (same as `Escape`). |
| Arrow keys | Navigate the `/research-config` menu |
| `Enter` / `Space` | Cycle a setting's value |

### Configuration

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

### Coding-agent skill installer

The `/research-config` menu can install the `pi-research` skill into your other
coding agents detected on this machine so they can run web research through the
CLI, and remove it again — with exact, manifest-tracked cleanup. See
[AGENT-SKILL.md](AGENT-SKILL.md) for the full installation flow.

### Lifecycle

- `activate` — registers commands, tools, the TUI controller, and initializes services.
- `deactivate` — drains the writer queue, closes LanceDB, terminates the browser pool, disposes the embedding model.
- `session_shutdown` — branches on `event.reason`: a `quit` triggers process-exit cleanup; reload / new / resume / fork clean up without exiting.

Extension state is isolated per pi session, so `/reload` is safe.
