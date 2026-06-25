# research — an Agent Skill for pi-research

A portable [Agent Skill](https://agentskills.io/specification) that gives any
coding agent **multi-agent web research** by driving the
[pi-research](https://github.com/Lincoln504/pi-research) engine. It is the same
engine the `pi` extension uses, packaged as a skill so Claude Code, Cursor,
Codex, Gemini CLI, and other Agent-Skills-compatible tools can use it.

## What it exposes

Two capabilities, invoked as shell subcommands:

- **`research "<query>"`** — live multi-agent web research (search + stealth
  scraping + security databases + Stack Exchange). Returns a cited Markdown report.
- **`knowledge "<query>"`** — search a local database of previously researched
  findings before doing live research (instant, free, opt-in).

Plus **`status`** to inspect detection/config without running research.

## How it works

```
agent  ──Bash──▶  scripts/run.mjs  ──spawns──▶  pi-research engine (dist/cli.mjs)
                 (finds the engine,                (uses the SDK: init → run → shutdown)
                  clean errors if missing)              │
                                                        ▼
                                              Markdown report → stdout
```

The launcher (`scripts/run.mjs`) is zero-dependency and locates the engine
wherever it's installed (PATH / `node_modules` / `~/.pi/bin` / `PI_RESEARCH_PATH`).
The engine wraps the [pi-research SDK](https://www.npmjs.com/package/@lincoln504/pi-research)
and fails fast with actionable messages + config locations when the package or a
model/key is missing.

## Prerequisites

- Node.js >= 22.19
- `pi-research` installed somewhere the launcher can find it, **and** a model +
  API key configured. See [`references/configuration.md`](references/configuration.md).

```bash
npm install -g @lincoln504/pi-research
node "<skill_dir>/scripts/run.mjs" status  # verify detection
```

## Install the skill

**Automated (recommended).** With the global CLI installed
(`npm install -g @lincoln504/pi-research`), let the CLI detect your harnesses and
symlink the skill in:

```bash
pi-research skills                 # show detected harnesses + install state
pi-research install-skill --all    # symlink into all detected, confirmed targets
pi-research uninstall-skill --all  # remove (also runs on npm uninstall)
```

**Manual.** Or copy/symlink this `research/` directory into your agent's skills folder:

| Agent | Location | Auto-installer id |
|-------|----------|-------------------|
| Claude Code (personal) | `~/.claude/skills/research/` | `claude-code` |
| Claude Code (project)  | `<project>/.claude/skills/research/` | — |
| pi                     | `~/.pi/skills/research/` | `pi` |
| Cursor                 | `~/.cursor/skills/research/` | `cursor` (opt-in) |
| Codex CLI              | `~/.codex/skills/research/` | `codex` (opt-in) |
| Cross-client default   | `~/.agents/skills/research/` | `agents` (opt-in) |

Then just ask your agent to research something — its skill system matches the
`description` in `SKILL.md` and activates this skill automatically.

## Usage from an agent

```bash
node "<skill_dir>/scripts/run.mjs" research "solid-state battery progress 2026" --depth 2
node "<skill_dir>/scripts/run.mjs" knowledge "openai gpt-5 release date"
node "<skill_dir>/scripts/run.mjs" status
```

## Files

- `SKILL.md` — the skill definition + system prompt (what agents read).
- `scripts/run.mjs` — the launcher (compiled from `run.ts`).
- `references/configuration.md` — model/key setup and the full variable reference.

## License

MIT.
