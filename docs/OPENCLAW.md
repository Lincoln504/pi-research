# OpenClaw Plugin

pi-research is a native [OpenClaw](https://openclaw.ai) plugin
(`src/openclaw-entry.ts`, bundled to `dist/openclaw-entry.js`). It exposes the
same multi-agent research engine as the pi extension, packaged as an OpenClaw
plugin.

## Install

```bash
openclaw plugins install npm:@lincoln504/pi-research
```

This is the supported install path. The published npm tarball ships the prebuilt
plugin bundle (`dist/openclaw-entry.js`) plus all runtime dependencies, so it
installs and loads without a build step.

`openclaw plugins install git:…` is **not** supported: OpenClaw installs plugins
with `--ignore-scripts`, so the package's build (`prepare`) never runs and the
prebuilt bundle — which is not committed to git — would be absent. Use the npm
spec above. (The pi extension, by contrast, does build on install, so it can be
installed from git via `pi install`.)

Requires a host whose plugin API is `>=2026.5.17` (declared as `openclaw.compat.pluginApi` in `package.json`).

### Browser provisioning

The stealth browser (camoufox) is normally fetched by the package's
`postinstall`. Because OpenClaw installs plugins with `--ignore-scripts`, that
postinstall does not run, so pi-research fetches the browser **lazily on first
use** instead — the first research run downloads it once (~100MB) before the
browser pool starts. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to opt out (then
fetch manually with `npx camoufox-js fetch`).

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

The complete environment-variable list and the full config model are in
[CONFIGURATION.md](CONFIGURATION.md).

## Lifecycle

The plugin initializes its services on first use and tears them down on the host's
cleanup hook — draining the writer queue, closing LanceDB, terminating the browser
pool, and disposing the embedding model, in dependency order. Per-session metrics
are cleared on shutdown so a plugin reload does not leak counters.
