## Configuration

The skill drives the **pi-research** engine, which needs an explicitly configured
model (`PI_RESEARCH_MODEL`) + API key — it runs only on that configured model and
never follows the model selected inside the pi extension.
Run `node "<SKILL_DIR>/scripts/run.mjs" status` to print what's detected and where
to configure (no research runs).

### Credentials — resolution order

1. **Env vars** (most portable):
   ```sh
   export PI_RESEARCH_API_KEY=sk-...
   export PI_RESEARCH_PROVIDER=openai        # openai, anthropic, google, openrouter, …
   export PI_RESEARCH_MODEL=openai/gpt-4o    # provider/model-id
   ```
2. **Global config** `~/.pi/research/config.env` (same KEY=VALUE keys; read at startup).
3. **pi configuration** (if you use `pi`): the API key comes from your pi
   configuration automatically — `PI_RESEARCH_MODEL` must still be set (env or `config.env`).

Real env vars always win. Optional CLI-only overlay `~/.pi/research/cli.env` layers
over `config.env` for the CLI only. Precedence:
`defaults < config.env < cli.env < project registry < real env`.

### Common settings (optional; env or `config.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_MODEL` | _(required)_ | The `provider/model-id` all research runs on. |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` | `1` | Default depth (1–3) when `--depth` omitted. |
| `PI_RESEARCH_MAX_RESEARCHERS` | `3` | Parallel researchers (1–5). |
| `PI_RESEARCH_TIMEOUT_MS` | `300000` | Per-researcher timeout (180000–1800000). |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES` | `2` | Scrape batches per researcher (0 = unlimited). |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS` | `3` | Videos per `youtube_transcript` call (1–5). |
| `PI_RESEARCH_YOUTUBE_QUERY_EVERY_N` | `5` | Append `youtube` to ~one-in-N queries (1 = every). |
| `PI_RESEARCH_KNOWLEDGE_STORE_MODE` | `global` | Knowledge DB: `none`, `project`, `global`. |
| `PI_RESEARCH_EMBEDDING_DEVICE` | `auto` | Embedding backend: `auto`, `webgpu`, or `cpu` (`auto` probes the GPU and falls back to CPU; raw `webgpu` is forced and can hard-crash on a software GPU). |
| `PI_RESEARCH_REPORT_EXPORT_ENABLED` | `false` | Write report to `.md` and print its path. |
| `STACKEXCHANGE_API_KEY` | — | Raises Stack Exchange rate limits (optional). |
| `GITHUB_TOKEN` | — | Raises GitHub Advisory limit (optional). |
| `NVD_API_KEY` | — | Raises NVD limit (optional). |

`knowledge` needs a store mode other than `none`. With
`PI_RESEARCH_REPORT_EXPORT_ENABLED=true`, the report ends with
`Research report saved to: <path>` — surface that path.

### Knowledge-store scope (per-directory)

`PI_RESEARCH_KNOWLEDGE_STORE_MODE` is **per-directory** (project-scoped): `global` (one
shared store — the default), `project` (scoped to the current directory), or `none`
(disabled here). The user changes it by asking you in chat; when they do, run it for them:

```sh
node "<SKILL_DIR>/scripts/run.mjs" knowledge-config                     # current mode + its source
node "<SKILL_DIR>/scripts/run.mjs" knowledge-config set none|project|global
```

`set` persists to the per-directory project registry (`~/.pi/research/state/
project-settings.json`, keyed by the directory) and applies on the next run. It overrides a
machine-wide `config.env` default; a real `PI_RESEARCH_KNOWLEDGE_STORE_MODE` env var still
outranks both (the command says so when that happens).

### Exit codes

`0` success · `64` bad arguments · `78` not configured (engine missing or no
model/key; message lists the fix) · `70` runtime error (network/provider/internal).

### Troubleshooting

- **"engine not found" (78 from launcher):** not installed —
  `npm i -g @lincoln504/pi-research`, or `pi install npm:@lincoln504/pi-research`,
  or `export PI_RESEARCH_PATH=/path/to/pi-research` (package dir), or
  `export PI_RESEARCH_BIN=/path/to/pi-research/dist/cli.mjs` (exact CLI entry;
  checked first — also the escape hatch for unusual Windows shim layouts).
- **"No model or API key" (78 from engine):** set the three env vars (or config /
  pi's configuration), then re-run `status`.
- **Rate limit (70):** provider returned 429 — wait and retry.
- **GPU/embedding errors:** set `PI_RESEARCH_EMBEDDING_DEVICE=cpu` (headless/no-GPU).

Full variable list + precedence model: `docs/CONFIGURATION.md` in the pi-research repo.
