# OpenClaw Plugin

pi-research is a native [OpenClaw](https://openclaw.ai) plugin
(`src/openclaw-entry.ts`, bundled to `dist/openclaw-entry.js`). It exposes the
same multi-agent research engine as the pi extension, packaged as an OpenClaw
plugin.

## Install

```bash
openclaw plugins install npm:@lincoln504/pi-research
```

Requires a host whose plugin API is `>=2026.5.17` (declared as `openclaw.compat.pluginApi` in `package.json`).

## Usage

The plugin registers the research tools with the OpenClaw host. The agent invokes
them like any other tool — ask it to research a topic and it calls the engine,
returning a cited Markdown report. When report export is enabled, the report ends
with a `Research report saved to: <path>` line.

## Configuration

The plugin reads the shared base config plus its own optional overlay:

- **Base** — `~/.pi/research/config.env`.
- **OpenClaw overlay** — `~/.pi/research/openclaw.env` (optional; layers over the
  base for the OpenClaw plugin only).

Plus any plugin options the host passes (e.g. `reportExportEnabled`) map onto the
same typed configuration. Real environment variables override the files.

Precedence: `defaults < config.env < openclaw.env < project registry < process.env`.

The complete environment-variable list and the full config model are in the
[SDK & configuration reference](SDK.md).

## Lifecycle

The plugin initializes its services on first use and tears them down on the host's
cleanup hook — draining the writer queue, closing LanceDB, terminating the browser
pool, and disposing the embedding model, in dependency order. Per-session metrics
are cleared on shutdown so a plugin reload does not leak counters.
