# Configuration

The skill drives the **pi-research** engine, which needs a model + API key.
Run `node "<SKILL_DIR>/scripts/run.mjs" status` to print what's detected and where
to configure (no research runs).

## Credentials — resolution order

1. **Env vars** (most portable):
   ```sh
   export PI_RESEARCH_API_KEY=sk-...
   export PI_RESEARCH_PROVIDER=openai        # openai, anthropic, google, openrouter, …
   export PI_RESEARCH_MODEL=openai/gpt-4o    # provider/model-id
   ```
2. **Global config** `~/.pi/research/config.env` (same KEY=VALUE keys; read at startup).
3. **pi auth** (if you use `pi`): `~/.pi/agent/auth.json` + `~/.pi/agent/models.json`.

Real env vars always win. Optional CLI-only overlay `~/.pi/research/cli.env` layers
over `config.env` for the CLI only. Precedence:
`defaults < config.env < cli.env < project registry < real env`.

## Common settings (optional; env or `config.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_MODEL` | session model | Model override for all research sub-tasks. |
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

## Exit codes

`0` success · `64` bad arguments · `78` not configured (engine missing or no
model/key; message lists the fix) · `70` runtime error (network/provider/internal).

## Troubleshooting

- **"engine not found" (78 from launcher):** not installed —
  `npm i -g @lincoln504/pi-research`, or `pi install npm:@lincoln504/pi-research`,
  or `export PI_RESEARCH_PATH=/path/to/pi-research`.
- **"No model or API key" (78 from engine):** set the three env vars (or config /
  pi auth), then re-run `status`.
- **Rate limit (70):** provider returned 429 — wait and retry.
- **GPU/embedding errors:** set `PI_RESEARCH_EMBEDDING_DEVICE=cpu` (headless/no-GPU).

Full variable list + precedence model: `docs/CONFIGURATION.md` in the pi-research repo.
