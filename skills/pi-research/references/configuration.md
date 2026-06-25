# Configuration

The research skill drives the **pi-research** engine. The engine needs a model
and an API key to run. Everything below applies whether you configure via this
skill or directly via the engine.

## Quick check

```bash
node "<SKILL_DIR>/scripts/run.mjs" status
```

This prints exactly what is detected and where to configure — no research runs.

## Where credentials come from

The engine resolves a model + key in this order:

1. **Environment variables** (most portable; works on any machine):
   ```sh
   export PI_RESEARCH_API_KEY=sk-...
   export PI_RESEARCH_PROVIDER=openai        # e.g. openai, anthropic, google, openrouter
   export PI_RESEARCH_MODEL=openai/gpt-4o    # provider/model-id
   ```
   Set these in your shell profile (`~/.zshrc`, `~/.bashrc`) or in your agent's
   environment configuration.

2. **Global config file** `~/.pi/research/config.env` (KEY=VALUE; same keys as
   the env vars above). The engine reads this file at startup and bridges any
   auth vars it contains into the environment. Example:
   ```sh
   PI_RESEARCH_API_KEY=sk-...
   PI_RESEARCH_PROVIDER=openai
   PI_RESEARCH_MODEL=openai/gpt-4o
   PI_RESEARCH_DEFAULT_RESEARCH_DEPTH=1
   ```

3. **pi auth storage** (if you use `pi`): `~/.pi/agent/auth.json` (API keys) and
   `~/.pi/agent/models.json` (model definitions). No extra setup if `pi` is
   already configured.

> Real environment variables always win over the config files.

**CLI-only overlay (optional).** To configure this CLI / skill independently of
the pi extension and the OpenClaw plugin, put overrides in
`~/.pi/research/cli.env` (same `KEY=VALUE` format). It layers over `config.env`
for the CLI only. Precedence: `defaults < config.env < cli.env < project registry < real env`.

## Common settings

All are optional; all live in `~/.pi/research/config.env` or the environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_RESEARCH_MODEL` | session model | Model override for all research sub-tasks. |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` | `1` | Default depth (1–3) when `--depth` is omitted. |
| `PI_RESEARCH_MAX_RESEARCHERS` | `3` | Parallel researchers (1–5). |
| `PI_RESEARCH_TIMEOUT_MS` | `300000` | Per-researcher timeout (180000–1800000 ms). |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES` | `2` | Scrape batches per researcher (0 = unlimited). |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS` | `3` | Videos per `youtube_transcript` call (1–5). |
| `PI_RESEARCH_YOUTUBE_QUERY_EVERY_N` | `5` | Append `youtube` to ~one-in-N search queries (1 = every query). |
| `PI_RESEARCH_KNOWLEDGE_STORE_MODE` | `global` | Knowledge DB: `none`, `project`, or `global`. |
| `PI_RESEARCH_EMBEDDING_DEVICE` | `webgpu` | Embedding backend: `webgpu` or `cpu`. |
| `PI_RESEARCH_REPORT_EXPORT_ENABLED` | `false` | Write the report to a `.md` file and print its path. |
| `STACKEXCHANGE_API_KEY` | — | Raises Stack Exchange rate limits (optional). |
| `GITHUB_TOKEN` | — | Raises the security tool's GitHub Advisory limit (optional). |
| `NVD_API_KEY` | — | Raises the security tool's NVD limit (optional). |

The `knowledge` subcommand requires a knowledge-store mode other than `none`.
When `PI_RESEARCH_REPORT_EXPORT_ENABLED=true`, the report ends with a
`Research report saved to: <path>` line — surface that path to the user.

## Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success. |
| `64` | Bad arguments. |
| `78` | Not configured — engine missing, or no model/key. The message lists where to fix. |
| `70` | Runtime error (network, provider, internal). |

## Troubleshooting

- **"engine not found" (exit 78 from the launcher):** pi-research isn't
  installed. `npm i -g @lincoln504/pi-research`, or `pi install npm:@lincoln504/pi-research`,
  or `export PI_RESEARCH_PATH=/path/to/pi-research`.
- **"No model or API key is configured" (exit 78 from the engine):** set the
  three env vars (or config file / pi auth), then re-run `status`.
- **Rate limit (exit 70):** a provider returned HTTP 429. Wait and retry.
- **GPU/embedding errors:** set `PI_RESEARCH_EMBEDDING_DEVICE=cpu` (headless
  servers without a GPU).

See the SDK & configuration reference (`docs/SDK.md` in the pi-research repo) for
the full variable list and the complete config-precedence model.
