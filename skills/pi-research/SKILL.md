---
name: pi-research
description: "Multi-agent web research for any coding agent. Use for anything requiring current information from the internet — news, trends, product/service/company facts, statistics, people, places, events, APIs, library behavior, or 'what is X / how does X work' questions. Also use to search a local knowledge store of previously researched findings before doing live research. Powered by the pi-research engine (search, stealth scraping, security databases, Stack Exchange). Not for reading local files, running project commands, or analyzing this repository's own source."
license: MIT
metadata: { "author": "Lincoln Deen", "version": "1.5.2", "package": "@lincoln504/pi-research", "engine": "pi-research-sdk", "openclaw": { "requires": { "bins": ["node"] } } }
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
  `knowledge` 600000ms · `research --depth 1` 1500000ms · `--depth 2` 1800000ms · `--depth 3` 2400000ms.
  These already include headroom for the run to sit **queued** behind other runs on a
  busy machine (see below); don't shorten them on the assumption a slot is free.
- **Background — use ONE mechanism, never two.** If your shell tool has its own
  background option (e.g. `run_in_background: true` on Claude Code's Bash tool), use
  that alone and do **not** also append `&`: with both, the shell forks the run and
  exits at once, the harness reports that instant exit as "completed" while the
  research continues detached, and the completion notification is meaningless. Only
  on a harness with no background option, append `&` and keep the PID — and then
  wait on that PID, not on any "completed" signal, before reading output. Otherwise
  it runs foreground (blocks). Timeouts apply either way.
- **Several at once is fine.** Up to 3 runs execute concurrently machine-wide (shared
  with any other tool or agent on this machine); further runs **queue** for a slot and
  report `• queued: …` on stderr — that is normal, not a stall. Only if nothing frees
  up within the queue window does a run exit `75` (see *Exit codes*). Prefer one
  `research` call with a well-scoped query over splitting one topic into many parallel
  calls — depth 1 already parallelises internally.

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
- **Surface the saved file.** Look for a saved-report line: stdout's report footer ends
  with `Research report saved to: <path>`, and stderr carries `[pi-research] report saved
  to: <path>`. Give the user that exact path. If neither appears, no file was written —
  say nothing about one.

## Exit codes

| Exit | Meaning | Action |
|------|---------|--------|
| `0` | Success | Read stdout; cite sources; relay any "saved to: <path>" line. |
| `78` on `knowledge` | Two cases — **read stderr to tell them apart.** | Says the store is **disabled**: silent; proceed to `research`. Mentions **credentials/model/API key**: this is the same hard config failure as `78` on `research` — **stop and relay full stderr**; don't silently continue, `research` will fail the same way. |
| `78` on `research` | Engine missing or no model/key | **Stop. Relay full stderr** (it shows where to configure). Don't retry until fixed. |
| `75` | Machine at capacity — other research runs are already using every slot | **Nothing is broken.** Wait for an in-flight run to finish, then retry this query once. Don't reconfigure anything and don't retry in a tight loop. |
| `130` (and `129`/`131`/`143`) | Cancelled — the run was interrupted. These are the POSIX `128 + signal` codes: `130` Ctrl-C/SIGINT, `143` SIGTERM, `129` SIGHUP, `131` SIGQUIT. Treat **any exit ≥ 128 as a cancellation.** | **Nothing is broken and nothing failed.** Say the research was cancelled. **Do NOT re-run it** unless the user asks; they stopped it deliberately. |
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
node "<SKILL_DIR>/scripts/run.mjs" knowledge-config set <none|project|global>   # pick ONE value
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
