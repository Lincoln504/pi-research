## research — an Agent Skill for pi-research

A portable [Agent Skill](https://agentskills.io/specification) that gives any
coding agent multi-agent web research by driving the
[pi-research](https://github.com/Lincoln504/pi-research) engine. It is the same
engine the `pi` extension uses, packaged as a skill so Claude, Codex, and other
Agent-Skills-compatible tools can use it.

### What it exposes

Two capabilities, invoked as shell subcommands:

- `research "<query>"` — live multi-agent web research (search + stealth
  scraping + security databases + Stack Exchange). Returns a cited Markdown report.
- `knowledge "<query>"` — search the local knowledge store of previously researched
  findings before doing live research (instant, free; the store is on by
  default in `global` mode and can be scoped or disabled via `knowledge-config`).

Plus `knowledge-config [set <none|project|global>]` to show or set the per-directory
knowledge-store mode, and `status` to inspect detection/config without running research.

### How it works

```
agent  ──Bash──▶  scripts/run.mjs  ──spawns──▶  pi-research engine (dist/cli.mjs)
                 (finds the engine,                (uses the SDK: init → run → shutdown)
                  clean errors if missing)              │
                                                        ▼
                                              Markdown report → stdout
```

The launcher (`scripts/run.mjs`) is zero-dependency and locates the engine
wherever it's installed (`PI_RESEARCH_BIN` / `PI_RESEARCH_PATH` / PATH /
`node_modules` / `~/.pi/bin`).
The engine wraps the [pi-research SDK](https://www.npmjs.com/package/@lincoln504/pi-research)
and fails fast with actionable messages + config locations when the package or a
model/key is missing.

### Prerequisites

- Node.js >= 22.19.0
- `pi-research` installed somewhere the launcher can find it, and a configured
  model (`PI_RESEARCH_MODEL`) + API key. See [`references/configuration.md`](references/configuration.md).

```bash
npm install -g @lincoln504/pi-research --allow-scripts=better-sqlite3
node "<skill_dir>/scripts/run.mjs" status  # verify detection
```

On npm 12 or newer the flag is needed: npm blocks the install script that builds the
stealth browser's SQLite module, and without it every search fails with a
missing-module error. It is harmless on older npm.

### Install the skill

Recommended. From the pi extension, run `/research-config` and choose
Install in External Agents. It detects the supported agents set up on this machine
and symlinks this skill into each one. Remove from External Agents removes those
symlinks.

Uninstalling the npm package does **not** remove them: npm 7 and newer do not run a
package's own `preuninstall` script (verified against npm 11). Use Remove from
External Agents first, or run `node scripts/cleanup.cjs` from the package directory,
otherwise the symlinks, `~/.pi/research/state` and the `~/.cache/pi-research` model
cache are all left behind.

Manual. Or symlink this `pi-research/` directory into your agent's skills folder:

| Agent | Location |
|-------|----------|
| Claude (personal) | `~/.claude/skills/pi-research/` |
| Claude (project)   | `<project>/.claude/skills/pi-research/` |
| Codex CLI (personal) | `~/.codex/skills/pi-research/` |
| Codex CLI (project)  | `<project>/.codex/skills/pi-research/` |
| OpenClaw (personal) | `~/.openclaw/skills/pi-research/` |

Then ask your agent to pi-research something — its skill system matches the
`description` in `SKILL.md` and activates this skill automatically.

### Usage from an agent

```bash
node "<skill_dir>/scripts/run.mjs" research "solid-state battery progress 2026" --depth 2
node "<skill_dir>/scripts/run.mjs" knowledge "openai gpt-5 release date"
node "<skill_dir>/scripts/run.mjs" status
```

### Files

- `SKILL.md` — the skill definition + system prompt (what agents read).
- `scripts/run.mjs` — the launcher (built from `run.ts`, which is a repo-only source
  file and is not shipped in the npm package).
- `references/configuration.md` — model/key setup and the full variable reference.

### License

MIT.
