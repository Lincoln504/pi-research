# Troubleshooting

## Searches fail with "Worker exited before completing the task"

Releases **1.7.9 through 1.7.18** broke every search for installs made with `pi install`: the
browser worker imported a package that `pi install` never installs, so each worker exited at
start-up. Update to **1.7.19 or newer**:

```bash
pi update npm:@lincoln504/pi-research
```

Then restart open pi sessions; a running session keeps the code it already loaded. To see which
version is installed, read `~/.pi/agent/npm/node_modules/@lincoln504/pi-research/package.json`.

For any other failure, set `PI_RESEARCH_DEBUG=true` and read the debug log (`$TMPDIR/pi-research.log`,
or `PI_RESEARCH_LOG_PATH`). Repeated `Worker exited with code 1` lines mean the browser worker is not
starting; the first error above the first exit says why. See [Configuration](CONFIGURATION.md#where-files-live).

## `pi update` prints errors for this extension

Check `~/.pi/agent/settings.json` (or run `pi list`) for a source spelled
`npm:lincoln504/pi-research`, without the `@`. npm reads `lincoln504/pi-research` as a GitHub
`user/repo`, so pi installs the repository's main branch instead of the published release (building
it, and registering the extension a second time). Remove the wrong entry and keep the right one:

```bash
pi remove npm:lincoln504/pi-research
pi list                      # should show npm:@lincoln504/pi-research once
pi update npm:@lincoln504/pi-research
```

A source with a version (`npm:@lincoln504/pi-research@1.7.9`) is pinned and never updates; remove and
reinstall it to move versions. A bare `pi update` updates pi itself; use `pi update --extensions` for
every extension or name the source for just this one.

## The agent skill or CLI says "cannot start — missing required runtime dependencies"

The `@earendil-works/pi-*` packages and `typebox` are **peer dependencies**. Inside pi nothing is
needed: pi supplies them to the extension. The standalone engine (the CLI, the agent skill and the
SDK) runs as a plain Node process, and an install that skips peers (`pi install` always does, as do
`npm install --legacy-peer-deps`, yarn classic and pnpm with `auto-install-peers=false`) has none
beside it.

The engine looks for pi's own copies, in this order, and uses them when it finds them:

1. the directory named by `PI_RESEARCH_HOST_DIR` (a `node_modules` directory, or its parent)
2. the directory behind the `pi` command on `PATH` (absolute `PATH` entries only)
3. pi's managed install, `<agent dir>/install/releases/<current version>/node_modules`
   (`~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set)
4. the global npm root of the Node that is running, bun's global root, then `npm root -g`

`PI_RESEARCH_NO_HOST_FALLBACK=1` turns the lookup off. If nothing is found, the message names the
missing packages and these fixes; any one is enough:

```bash
# into the tree pi-research is installed in (for pi: ~/.pi/agent/npm); kept across `pi update`
npm install --prefix ~/.pi/agent/npm --legacy-peer-deps @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui typebox
# or globally; a global install is found automatically
npm install -g @earendil-works/pi-coding-agent
# or a standalone engine that brings its peers in with it
npm install -g @lincoln504/pi-research
```

## Every browser scrape fails with "a response was served from a private/reserved address"

This was a bug in releases before the one that ships `src/infrastructure/browser/proxy-prefs.ts`, and it only affects hosts that route the browser through the local SOCKS proxy (`~/.pi/research/proxy.json`). Through a SOCKS5 proxy Firefox cannot report the origin's address and reports `0.0.0.0`, which the SSRF rebinding backstop classified as reserved, so every browser-fallback scrape was refused — the only path that reads sites which answer plain fetches with `403`.

Updating fixes it. To confirm the cause on an affected build, disable the proxy (rename `proxy.json`) and retry the same URL: if it now succeeds, that is this bug. The log signature is a `WARN` line `SSRF rebinding defense: a response connected to a private/reserved address; poisoning scrape of <url>` immediately followed by `Browser fallback did not yield content`.

**What the fix does and does not cover.** The check it exempts compares the address Firefox actually connected to against the address the hostname resolves to — that comparison is what catches DNS rebinding. A SOCKS5 proxy makes it impossible: Firefox never sees the origin address. So with a proxy configured, a page that rebinds a public hostname to an internal address is not caught at bake time. Two things still apply. Request-time DNS validation still runs on every navigation and every subresource the page pulls in, and rejects a hostname that resolves into private space before the request is allowed out. And `scripts/ddg-socks-proxy.mjs` (the proxy this project ships instructions for) now refuses to CONNECT to a loopback, private, link-local, CGNAT, multicast or reserved destination, checking both the requested host and every address it resolves to. A third-party SOCKS proxy you point `proxy.json` at does not have that guard — do not route through one you do not trust.

## The SOCKS proxy refuses a URL with "connection not allowed by ruleset"

That is `scripts/ddg-socks-proxy.mjs` blocking an SSRF attempt, not a bug: the destination was loopback, private, link-local (`169.254.169.254` metadata included), CGNAT, multicast or reserved, spelled either as the host or as the address it resolves to. The log line names it: `[ddg-socks] refused private/reserved destination <host>:<port>` or `refused <host> — resolves to private/reserved <addr>`. A research run never needs such a destination. If you added the proxy for a private mirror, run that request without the proxy.

## A research run used a different model than `~/.pi/research/config.env` says

Before the release that fingerprints the config sources, `getConfig()` cached configuration for the life of the process and never re-read it. Editing `config.env` from another shell, editor or pi session therefore did not affect a session that was already running, however long it lived. Restart pi (the loaded code and the loaded config are both fixed at start-up) or set the value through `/research-config`, which calls `resetConfig()`. Confirm what a run actually used: the report footer names the model, and the log carries `Using model for researcher <id>: <provider>/<model>`.

## The first scrape takes minutes, or install downloads over a gigabyte

The stealth browser (about 1 GB installed) is fetched by the `postinstall` script on npm 10 through
11.19, which includes the npm bundled with the Node 22.22.2 floor (10.9.7) and with Node 24/25
(11.19.0). npm 12 blocks dependency install scripts by default, so there the browser is fetched on the
first scrape instead. Either way it is a one-time download. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
to defer it deliberately.

## `npm audit` reports a high-severity `sharp` chain under `@lancedb/lancedb`

This affects releases before **1.7.18** only. LanceDB pins an old `@huggingface/transformers` as an
optional dependency and npm ignores a dependency's `overrides`. From 1.7.18 the package ships LanceDB
bundled with those optional edges removed, so nothing needs overriding; update instead. On an older
release the consumer-side override is in [AUDIT-GATE.md](AUDIT-GATE.md).
