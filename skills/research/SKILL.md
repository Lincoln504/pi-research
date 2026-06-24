---
name: research
description: >-
  Multi-agent web research for any coding agent. Use for anything requiring
  current information from the internet — news, trends, product/service/company
  facts, statistics, people, places, events, APIs, library behavior, or "what is
  X / how does X work" questions. Also use to search a local knowledge database
  of previously researched findings before doing live research. Powered by the
  pi-research engine (search, stealth scraping, security databases, Stack
  Exchange). Not for reading local files, running project commands, or analyzing
  this repository's own source.
license: MIT
metadata:
  author: Lincolndeen
  version: "1.0.0"
  package: "@lincoln504/pi-research"
  engine: "pi-research-sdk"
allowed-tools: Bash(node:*)
---

# research — pi-research skill

Run research by invoking the launcher with your **Bash** tool. Replace
`<SKILL_DIR>` with this file's parent directory.

```
node "<SKILL_DIR>/scripts/run.mjs" research  "<query>" --depth <1|2|3>
node "<SKILL_DIR>/scripts/run.mjs" knowledge "<query>" ["<q2>" ...]
node "<SKILL_DIR>/scripts/run.mjs" status    [--json]
```

**stdout** = Markdown report. Read it and cite it in your response.
**stderr** = progress lines and errors. Relay errors to the user; suppress routine progress.

---

## Foreground vs background

You can run the launcher either way — both are correct:

- **Foreground** (default): the Bash call blocks until the report arrives. Suitable for most queries.
- **Background**: append `&` to the command and collect the PID if you want to continue working while research runs. Retrieve output from the process when it exits. Use this when the user wants to keep chatting or when you have other work to do while a depth-2/3 run completes.

The timeouts below apply regardless of which mode you choose.

**Always set a Bash timeout** so a stalled run does not block indefinitely:

| Command | timeout |
|---------|---------|
| `knowledge` | 5 minutes (`timeout_ms: 300000`) |
| `research --depth 1` | 8 minutes (`timeout_ms: 480000`) |
| `research --depth 2` | 10 minutes (`timeout_ms: 600000`) |
| `research --depth 3` | 15 minutes (`timeout_ms: 900000`) |

---

## Step 1 — check knowledge store first (always)

Before any live research call, run one `knowledge` check with the same intent.
It is instant and free.

```
node "<SKILL_DIR>/scripts/run.mjs" knowledge "<query>"
```

- **Complete answer found** → use it; skip live research entirely.
- **Partial answer** → note what it found; fill gaps with live `research`.
- **Exit 78 (store disabled or empty)** → silent. Just proceed to `research`.
  Do not tell the user the knowledge store is disabled — it is an opt-in
  feature. Only surface it if the user asks how to enable it.

---

## Step 2 — live research

Default depth is **1**. Use it unless the topic genuinely requires more.

```
node "<SKILL_DIR>/scripts/run.mjs" research "<query>" --depth 1
```

**Depth rules:**

| Depth | Use when |
|-------|----------|
| `1` | **Default — almost always.** Lookups, news, facts, API/library behavior, recent releases, comparisons, CVEs. |
| `2` | Multi-angle analysis: policy, contested technical trade-offs, topics requiring cross-source corroboration. |
| `3` | Only when the user explicitly says "ultra", "exhaustive", or "comprehensive deep-dive". Never pick this yourself. |

The engine parallelises internally. Do not escalate depth just because a topic
is broad — depth 1 handles broad topics by decomposing them internally.

**Keyword extraction** (strip from query before passing):
- "quick / brief / simple" → `--depth 1`
- "deep / thorough / in-depth" → `--depth 2`
- "ultra / exhaustive / comprehensive" → `--depth 3`

---

## Exit codes — what to do

| Exit | Meaning | Action |
|------|---------|--------|
| `0` | Success | Read stdout; cite the report. |
| `78` on `knowledge` | Store disabled or not configured | Silent. Proceed to live `research`. |
| `78` on `research` | Engine missing or no model/key | **Stop. Relay the full stderr to the user.** It shows exactly where to configure. Do not retry until the user fixes the setup. |
| `70` | Runtime error | Relay the error from stderr. Suggest retrying once for transient failures (network, rate limit). |
| `64` | Bad arguments | Fix the arguments; do not surface to the user unless the query itself is malformed. |

---

## When not to use this

- Reading files in this project → Read/Grep
- Running commands or tests → Bash directly
- Anything answerable from the local codebase or session → your own tools

---

## Configuration (relay to user only on exit 78 from `research`)

When `research` exits 78, the engine prints the exact configure locations to
stderr. Relay that message verbatim. The locations are:

```
config file:  ~/.pi/research/config.env
env vars:     PI_RESEARCH_API_KEY  PI_RESEARCH_PROVIDER  PI_RESEARCH_MODEL
pi auth:      ~/.pi/agent/auth.json
pi models:    ~/.pi/agent/models.json
```

Run `status` to see the actual resolved paths on this machine:

```
node "<SKILL_DIR>/scripts/run.mjs" status
```

Full configuration reference: [`references/configuration.md`](references/configuration.md)

---

## Process cleanup

The engine shuts itself down cleanly on every exit — normal, error, and
signal (SIGINT/SIGTERM). Browser pool, LanceDB state, and embedding model
are all released. Nothing is left behind between runs.
