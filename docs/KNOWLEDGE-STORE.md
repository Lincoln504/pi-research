## Knowledge Store

The knowledge store is a local vector database of past research findings. It is an
optional cache (research works without it) and is used in two distinct ways:

- **Knowledge-first answering (advisory).** The `research_knowledge_search` tool
  answers a repeat or overlapping question directly from stored results. The agent is
  asked to try it *before* the live `research` tool, but this is guidance the model
  follows — it is not enforced, and `research_knowledge_search` is a separate tool, not
  a gate in front of `research`.
- **Seeding a live run (automatic).** A live `research` run never answers from the
  store; instead the orchestrator hands each researcher the previously useful URLs for
  its goal as starting points to re-scrape live.

![Knowledge-store hit — a cached answer returned without a live run](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/03-knowledge-store.gif)

Together these make repeat work faster and cheaper.

### What it stores

The store is a [LanceDB](https://lancedb.com) table on disk. After each research
round, the cited URLs from the researchers' reports are enqueued and written in the
background: each source's summary (and, when available, its full scraped Markdown) is
split into chunks, each chunk is embedded into a vector, and the rows are stored.

Each row carries the embedding vector, the source URL (normalized for
deduplication), the summary text and full content, a timestamp, and scope flags. A
content hash dedupes re-ingested URLs: an unchanged page is skipped; a changed page
replaces the old rows. The full page Markdown is cached once per document so a stored
finding can be rehydrated later without re-scraping.

Writes never block a research run — they go through an asynchronous writer queue that
is drained at the end of the round and on shutdown.

### Scopes: none, project, global

The store's reach is set by Knowledge Mode (`PI_RESEARCH_KNOWLEDGE_STORE_MODE`),
a project-scoped setting you can change per directory:

| Mode | Behavior |
|------|----------|
| `global` (default) | One store shared across every directory. A finding cached in one project is retrievable from any other. |
| `project` | Findings are scoped to the working directory they were created in; only that directory retrieves them. |
| `none` | The store is disabled — nothing is read or written, the `research_knowledge_search` tool is not advertised to the agent, and `/knowledge-store` is unavailable. Re-enabling needs no restart (see [PI-EXTENSION.md](PI-EXTENSION.md) for the registration mechanics). |

Change the mode for the current directory with the `/research-config` TUI (Knowledge Mode)
in the pi extension, or with `pi-research knowledge-config set <none|project|global>` (pick one value) on the
standalone CLI. The setting persists to the per-directory project registry — see
[CONFIGURATION.md](CONFIGURATION.md) for the full precedence chain. The change applies on
the next run — no restart.

All scopes share one physical LanceDB directory; project vs. global rows are
distinguished by columns (a normalized workspace path and a global flag) and filtered
at query time, not by separate folders. The default database directory is
`~/.pi/research/knowledge_db/` (override with `PI_RESEARCH_KNOWLEDGE_DIR`).

The embedding model is lazy — it only downloads and initializes the first time
the store is actually written or searched, so the `global` default adds no startup
cost until a run caches its first page.

### How a run uses the store

The store is driven by the orchestrator, not called ad hoc by researcher agents,
which keeps its use deterministic:

1. Before each researcher starts, the orchestrator searches the store for the
   researcher's goal and injects any matching historical URLs — each with its prior
   summary — into that researcher's prompt as suggested starting points to re-scrape.
2. After the round, the cited URLs and their descriptions are enqueued into the
   writer queue for the next session.

Separately, the `research_knowledge_search` tool (and the SDK's `searchKnowledge()`)
lets the model query the store directly: it rehydrates the most relevant stored
documents, asks a background LLM whether they answer the question, and returns a
synthesized answer with citations — or reports that live research is needed.

### Embeddings and the model

Embeddings are computed locally with
[`@huggingface/transformers`](https://github.com/huggingface/transformers.js) over
ONNX. The default model is
`onnx-community/granite-embedding-small-english-r2-ONNX` (English; a 512-token
chunk window). Each supported model defines its own chunk size, pooling strategy,
and prefixes, and produces a fixed vector dimension that the table's schema is built
around.

Supported models (`PI_RESEARCH_EMBEDDING_MODEL`):

| Model | Languages |
|-------|-----------|
| `onnx-community/granite-embedding-small-english-r2-ONNX` (default) | English |
| `Xenova/multilingual-e5-small` | Multilingual |
| `Xenova/multilingual-e5-base` | Multilingual |
| `Xenova/bge-m3` | Multilingual |
| `onnx-community/embeddinggemma-300m-ONNX` | Multilingual |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | Multilingual |
| `Xenova/all-MiniLM-L6-v2` | English |
| `Xenova/bge-small-en-v1.5` | English |
| `Xenova/all-mpnet-base-v2` | English |

Changing the model invalidates existing vectors (they have a different dimension and
meaning), so the store is migrated (see Changing the model, below).
The model is downloaded from Hugging Face on first use and cached; the first download
can take a few minutes (raise `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` on a slow
connection).

### Device selection

Embeddings run on either the GPU (WebGPU, via the runtime's bundled Dawn backend) or
the CPU. The backend is chosen by `PI_RESEARCH_EMBEDDING_DEVICE`:

- `auto` (default; shown as GPU in the TUI) — pi-research probes WebGPU
  viability in a disposable child process: it loads the model and runs one real
  embedding there. If that succeeds, the GPU is used; if it fails, the CPU is used.
  The verdict is cached, so the probe runs at most once per machine + model.
- `cpu` (shown as CPU in the TUI) — forces CPU inference, no probe.
- `webgpu` — forces the GPU path with no probe. Advanced / env-only; see below.

Why the probe exists. Some hosts — VMs, containers, CI runners, headless machines
with a software Vulkan driver — expose a GPU the native backend cannot run compute
on. That failure is a native segfault, not a catchable error, so it terminates the
process. The `auto` probe tests viability in a child process (whose crash cannot
affect the main process) and falls back to CPU. Forcing `webgpu` skips this check and
can crash on such a host, so the `/research-config` menu offers only GPU (= `auto`)
and CPU. Raw `webgpu` stays available through the environment variable for
benchmarking on a host with a known-good GPU.

The cached verdict lives at `~/.cache/pi-research/webgpu-viability.json`, keyed by
platform, architecture, Node major version, and model. Set
`PI_RESEARCH_WEBGPU_REPROBE=1` to discard it and probe again (for example after a
driver upgrade).

### Platform support (no Intel Mac)

The store depends on two native components — the ONNX runtime for embeddings and
LanceDB for vector storage — that ship prebuilt binaries only for certain
platform/architecture pairs:

| Platform | Architecture | Knowledge store |
|----------|--------------|-----------------|
| macOS | Apple Silicon (arm64) | Supported |
| macOS | Intel (x64) | Not available |
| Linux | x64 / arm64 | Supported |
| Windows | x64 / arm64 | Supported |

Intel Macs (`darwin-x64`) have no prebuilt binary for either component, so the
knowledge store cannot run there. The same clean OFF applies on any platform when a
required package is not installed at all — optional `@huggingface/transformers` is
skipped by `npm install --omit=optional` (and by an npm optional-dependency bug), or
the `@lancedb/lancedb` install is broken. The degradation is automatic and fast:

- Research still works. Search, scraping, YouTube transcripts, the security databases,
  Stack Exchange, planning, and synthesis are unaffected — only the store is missing.
- The store fails fast. Missing packages are detected by resolution before any
  initialization is attempted, so there is no retry storm — the store simply starts OFF.
- The settings surfaces say why. `pi-research knowledge-config`, the `/research-config`
  menu, and the health check name the missing package and the repair (install the
  optional dependencies) instead of advertising a mode the store cannot honor. A
  `research_knowledge_search` miss reports the package gap rather than pointing at a
  settings toggle that cannot help.
- The health check reports the store as disabled, not unhealthy, so the missing
  component does not drag overall health to "unhealthy" or block a quick (depth-0) run.

No configuration is needed: install the package (a full install including optional
dependencies) and the store comes up; a mode flip alone cannot revive it mid-process.

### Retention and eviction

Cached findings are kept for `PI_RESEARCH_CACHE_TTL_DAYS` (default 30; range 1–365).
Eviction is checked when the store opens and removes only rows older than the cutoff
within the current scope. Lower the value for fresher data and less disk; raise it to
keep history longer.

### Changing the model: migration

When the configured embedding model differs from the one the stored vectors were
built with, the store is migrated according to `PI_RESEARCH_MIGRATION_STRATEGY`:

| Strategy | What happens |
|----------|--------------|
| `backup` (default) | The old table is renamed aside (`knowledge_backup_<timestamp>.lance`) and a fresh table is created for the new model. Old data is preserved on disk but not searched. |
| `drop` | The old table is discarded and a fresh one created. Fast; no backup. |
| `re-embed` | Every stored document is re-embedded with the new model into a new table, preserving history. Slowest. |

If `re-embed` fails, pi-research falls back to `backup`. A failed `backup` (or
`drop`) aborts the migration instead: the store stays on the old model and the
next open retries — data is never dropped unless `drop` was chosen explicitly.
Changing the model from the `/research-config` menu prompts for confirmation
before clearing the current store and starting fresh; declining reverts the model
change and leaves the store intact.

### Managing the store

From `/research-config`:

- Store Status — entry counts (project and user), the active embedding model
  and device, and the on-disk path.
- Clear Project Store / Clear User Store — permanently delete the
  project-scoped or global rows (shown according to the current mode).
- Run Health Check — exercises the browser pool, GPU/embedding, and knowledge
  store connectivity, and reports the store's health state.

The store grows copy-on-write (each run appends a version), so it is compacted
automatically after any run that changed the stored data — stale versions and
indices are pruned to keep it bounded. There is no manual maintenance command.

### Settings

| Setting | Variable | Default |
|---------|----------|---------|
| Knowledge Mode (project-scoped) | `PI_RESEARCH_KNOWLEDGE_STORE_MODE` | `global` |
| Embedding model | `PI_RESEARCH_EMBEDDING_MODEL` | `onnx-community/granite-embedding-small-english-r2-ONNX` |
| Embedding device | `PI_RESEARCH_EMBEDDING_DEVICE` | `auto` |
| Cache retention (days) | `PI_RESEARCH_CACHE_TTL_DAYS` | `30` |
| Migration strategy | `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` |
| Database directory | `PI_RESEARCH_KNOWLEDGE_DIR` | `~/.pi/research/knowledge_db` |
| Model init timeout (ms) | `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` |
| Re-probe WebGPU | `PI_RESEARCH_WEBGPU_REPROBE` | _(unset)_ |

See [CONFIGURATION.md](CONFIGURATION.md) for the full configuration model, and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the store fits into the
engine.
