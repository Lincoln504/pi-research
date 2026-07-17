---
name: pi-research
description: "Multi-agent web research for any coding agent. Use for anything requiring current information from the internet — news, trends, product/service/company facts, statistics, people, places, events, APIs, library behavior, or 'what is X / how does X work' questions. Also use to search a local knowledge store of previously researched findings before doing live research. Powered by the pi-research engine (search, stealth scraping, security databases, Stack Exchange). Not for reading local files, running project commands, or analyzing this repository's own source."
license: MIT
metadata: { "author": "Lincoln Deen", "version": "1.0.8", "package": "@lincoln504/pi-research", "engine": "pi-research-sdk", "openclaw": { "requires": { "bins": ["node"] } } }
allowed-tools: Bash(node:*)
---

# pi-research skill

Run via your shell tool — the **Bash** tool in Claude Code, the **`exec`** tool in
OpenClaw. `<SKILL_DIR>` is this skill's own directory: substitute the absolute path
your harness reports for this skill (in OpenClaw, `{baseDir}` resolves to it).

```
node "<SKILL_DIR>/scripts/run.mjs" research  "<query>" --depth 1
node "<SKILL_DIR>/scripts/run.mjs" knowledge "<query>" ["<q2>" ...]
node "<SKILL_DIR>/scripts/run.mjs" status    [--json]
```

- **stdout** = Markdown report — read and cite it.
- **stderr** = progress + errors — relay errors, suppress routine progress.
- **Always set a generous command timeout** so a stalled run can't block forever, but
  leave plenty of headroom — a real run should finish well inside it:
  `knowledge` 600000ms · `research --depth 1` 900000ms · `--depth 2` 1200000ms · `--depth 3` 1800000ms.
- **Background**: append `&` and keep the PID to work while a run completes; otherwise it runs foreground (blocks). Timeouts apply either way.

## Workflow

1. **Knowledge store first (always).** Run one `knowledge` check with the same
   intent before any live research — it's instant and free.
   - Complete answer → use it, skip live research.
   - Partial → note it, fill gaps with `research`.
   - Exit 78 → store is off in this directory; proceed with `research`. Don't mention it
     unless the user asks — then see *Knowledge store scope* below to turn it on.
2. **Live research — always depth `1`.** It's the default and correct for
   effectively every request; depth 1 already decomposes and parallelises
   internally, so it covers big/broad/complex/important topics too. Do NOT raise
   depth on your own judgment.
   - **Depth `2` — super rare:** only a genuinely ultra-broad or unusually detailed
     topic where the user signalled they want deeper/thorough work. Unsure → depth 1.
   - **Depth `3` — never** unless the user explicitly asks for ludicrously deep /
     exhaustive research ("ultra", "exhaustive", "comprehensive deep-dive", "maximum").

## Reporting back to the user (always)

- **Cite the report's sources.** Carry its URLs/`[n]` references into your answer;
  attribute each non-trivial claim. Never present researched facts as unsourced;
  never invent or substitute sources.
- **Surface the saved file.** If stderr/stdout ends with `Research report saved to: <path>`,
  give the user that exact path. If absent, no file was written — say nothing about one.

## Exit codes

| Exit | Meaning | Action |
|------|---------|--------|
| `0` | Success | Read stdout; cite sources; relay any "saved to: <path>" line. |
| `78` on `knowledge` | Store disabled/unconfigured | Silent; proceed to `research`. |
| `78` on `research` | Engine missing or no model/key | **Stop. Relay full stderr** (it shows where to configure). Don't retry until fixed. |
| `70` | Runtime error | Relay stderr; suggest one retry for transient failures (network, rate limit). |
| `64` | Bad arguments | Fix args; don't surface unless the query itself is malformed. |

## Knowledge store scope (act on the user's request)

The knowledge store — what `knowledge` searches — is **on by default** (mode `global`) and
scoped per directory: `global` (one shared store), `project` (this directory only), or `none`
(off here). The user manages it by **asking you in chat** — they don't have to run anything themselves.

When the user asks you to turn the store off, make it global, or scope it to this project for
the current directory (or clearly implies a preference), do it on their behalf and tell them
the new setting. Check the current one first if useful:

```
node "<SKILL_DIR>/scripts/run.mjs" knowledge-config                    # current mode + where it's set
node "<SKILL_DIR>/scripts/run.mjs" knowledge-config set none|project|global
```

The change applies to the current directory on the next run. Never change it unprompted.

## When NOT to use this

WEB / internet research ONLY. Never use it to investigate *this* project (source,
config, architecture, tests, logs, anything on this machine) — use your own
Read/Grep/Bash for that. Reach for `pi-research` only when the answer lives on the
public internet or in the knowledge store.

## Configuration (relay only on exit 78 from `research`)

On exit 78 the engine prints exact configure locations to stderr — relay verbatim:

```
config file:  ~/.pi/research/config.env
env vars:     PI_RESEARCH_API_KEY  PI_RESEARCH_PROVIDER  PI_RESEARCH_MODEL
pi config (keys):    ~/.pi/agent/auth.json   (supplies the API key only)
pi config (models):  ~/.pi/agent/models.json
```

`PI_RESEARCH_MODEL` (a `provider/model-id`) is always required — pi's configuration
supplies only the key, and the skill never uses the model selected inside the pi extension.

Run `status` for the resolved paths on this machine. Full reference:
[`references/configuration.md`](references/configuration.md).

The engine shuts down cleanly on every exit (browser pool, LanceDB, embedding
model all released) — nothing is left behind between runs.
