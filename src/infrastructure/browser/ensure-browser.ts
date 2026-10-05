/**
 * Runtime browser (camoufox) provisioning.
 *
 * Normally the camoufox browser is fetched by the `postinstall` script
 * (scripts/setup.cjs) when pi-research is installed. But some install flows skip
 * lifecycle scripts (e.g. `npm install --ignore-scripts`, or a bare `git clone`
 * whose `npm install` has not yet run) and therefore never run our postinstall.
 * On those the browser binary is absent and the first scrape would fail with
 * "Camoufox is not installed".
 *
 * `ensureBrowserInstalled()` closes that gap: it is called once before the worker
 * pool spawns and lazily fetches the browser if (and only if) it is missing.
 *
 * Non-regression guarantee for the other install paths: when the browser is
 * already present — which it always is after the pi-extension / plain-npm
 * postinstall fetch — this is a cheap layout check that returns
 * immediately and changes nothing. It only ever does work when the paired
 * browser build is genuinely absent (or a legacy flat install needs migrating).
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, fstatSync, openSync, closeSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, platform, homedir } from 'node:os';
import { logger } from '../../logger.ts';
import { getCamoufoxBinaryPath } from './config.ts';
import { resolveInstall, isUsable, provisionBrowser, loadPin, findPackageRoot, type BrowserPin } from './camoufox-layout.ts';

/** Bound the ~1.3GB Camoufox browser download (the paired build is ~1.29 GB) so a stalled
 *  network fails eventually instead of hanging forever, while a slow-but-working link can
 *  actually finish. */
const FETCH_TIMEOUT_MS = 45 * 60 * 1000;
/** A lock older than this is considered stale (crashed mid-fetch) and may be stolen.
 *  Must exceed FETCH_TIMEOUT_MS: stealing a LIVE fetcher's lock mid-download would
 *  start a second download beside the first. */
const STALE_LOCK_MS = 55 * 60 * 1000;
/** When another process holds the fetch lock, poll this long for the browser to appear.
 *  Spans a full FETCH_TIMEOUT_MS fetch, so a legitimate slow peer is waited out rather
 *  than duplicated. */
const WAIT_FOR_PEER_MS = 50 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

/** In-process dedupe: concurrent pool inits / scrapers share one fetch. */
let inFlight: Promise<void> | null = null;

/** The paired browser build this installed @camoufox/camoufox was released with. */
function currentPin(): BrowserPin | null {
  const root = findPackageRoot(import.meta.url);
  return root ? loadPin(root) : null;
}

/**
 * True when a usable Camoufox browser is installed: the new layout's compat flag plus
 * the build this launcher is paired with (any build when the user chose one explicitly).
 * A bare "directory exists" is NOT enough: a legacy flat camoufox-js install is a
 * non-empty directory too, and the launcher deletes it on first use.
 */
export function isBrowserBinaryPresent(): boolean {
  try {
    return isUsable(getCamoufoxBinaryPath(), currentPin());
  } catch {
    return false;
  }
}

/** Resolve the `camoufox` CLI entry (JS file) of @camoufox/camoufox, mirroring scripts/setup.cjs. */
function resolveCamoufoxCli(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('@camoufox/camoufox/package.json');
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['camoufox'];
    if (rel) {
      const entry = join(dirname(pkgJson), rel);
      if (existsSync(entry)) return entry;
    }
  } catch {
    /* fall through */
  }
  return null;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `camoufox fetch`, resolving true on exit 0, false on any other exit, rejecting on
 * spawn error / timeout. Runs the CLI's JS entry with process.execPath and an argv array:
 * no shell, so neither a spaced Windows path nor a metacharacter in an install directory
 * can be reinterpreted.
 */
function runFetch(): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const cli = resolveCamoufoxCli();
    if (!cli) {
      reject(new Error('@camoufox/camoufox is not installed (cannot find its CLI); run npm install'));
      return;
    }
    // The launcher reads only XDG_CACHE_HOME / LOCALAPPDATA: hand it the override derived
    // from the user's CAMOUFOX_INSTALL_DIR / PLAYWRIGHT_BROWSERS_PATH so the fetch lands
    // where the lookup (getCamoufoxBinaryPath) expects it.
    const install = resolveInstall(process.env, platform(), homedir());
    const env: NodeJS.ProcessEnv = { ...process.env, ...install.overrides };
    delete env['CAMOUFOX_INSTALL_DIR'];
    delete env['PLAYWRIGHT_BROWSERS_PATH'];
    logger.info(`[ensure-browser] Camoufox not found; fetching the browser (this runs once, ~1.3GB): ${process.execPath} ${cli} fetch`);

    const child = spawn(process.execPath, [cli, 'fetch'], { stdio: 'inherit', env });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`camoufox fetch timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** Wait for a peer process (holding the lock) to finish fetching the browser. */
async function waitForPeer(): Promise<boolean> {
  const deadline = Date.now() + WAIT_FOR_PEER_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    if (isBrowserBinaryPresent()) return true;
  }
  return false;
}

async function provision(): Promise<void> {
  // Fast path: already installed (pi-extension / plain-npm postinstall case).
  if (isBrowserBinaryPresent()) return;

  // Respect the same opt-out the postinstall fetch honours (used by CI/tests).
  if (process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] === '1') {
    logger.debug('[ensure-browser] Browser missing but PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; skipping auto-fetch.');
    return;
  }

  // Cross-process lock so two concurrent first-runs don't double-fetch. Scoped
  // by a hash of the target cache dir so distinct cache locations (e.g. a
  // PLAYWRIGHT_BROWSERS_PATH override, or different users) never share a lock.
  const cacheKey = createHash('sha256').update(getCamoufoxBinaryPath()).digest('hex').slice(0, 16);
  const lockPath = join(tmpdir(), `pi-research-camoufox-fetch-${cacheKey}.lock`);
  let haveLock = false;
  try {
    // 'wx' = O_CREAT|O_EXCL: fails if another process holds it. Mode 0o600 keeps
    // the (empty) lock owner-only, matching FileLockService and avoiding a
    // world-readable temp file.
    closeSync(openSync(lockPath, 'wx', 0o600));
    haveLock = true;
  } catch {
    // Lock held — but steal it if it's stale (a crash left it behind). Read the
    // mtime through a file descriptor rather than re-stat'ing by path (avoids a
    // check-then-use race), then re-acquire with O_EXCL: a process that recreated
    // the lock in the meantime makes our 'wx' create fail, so we never double-acquire.
    try {
      let mtimeMs: number;
      const fd = openSync(lockPath, 'r');
      try {
        mtimeMs = fstatSync(fd).mtimeMs;
      } finally {
        closeSync(fd);
      }
      if (Date.now() - mtimeMs > STALE_LOCK_MS) {
        rmSync(lockPath, { force: true });
        closeSync(openSync(lockPath, 'wx', 0o600));
        haveLock = true;
      }
    } catch {
      /* someone won the race; fall through to wait */
    }
  }

  if (!haveLock) {
    // Another process is fetching — wait for it, then re-check.
    logger.info('[ensure-browser] Another process is fetching the browser; waiting for it to finish…');
    if (await waitForPeer()) return;
    // Peer didn't deliver in time; fetch ourselves as a fallback.
  }

  try {
    if (isBrowserBinaryPresent()) return; // re-check under lock
    // Guarded: a legacy flat camoufox-js install is moved aside first (the fetch, and the
    // launcher itself, delete a non-empty dir without the compat flag), and is removed
    // only after the new build verifies. A failed fetch restores it. See camoufox-layout.ts.
    const result = await provisionBrowser(getCamoufoxBinaryPath(), runFetch, (m) => logger.info(`[ensure-browser] ${m}`), currentPin());
    if (result.status === 'failed') {
      throw new Error(result.reason ?? 'camoufox fetch failed');
    }
    logger.info('[ensure-browser] Camoufox browser is ready.');
  } finally {
    if (haveLock) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Ensure the camoufox browser is installed, fetching it once if missing.
 *
 * Idempotent and concurrency-safe: concurrent callers share a single fetch, and
 * a cross-process lock prevents two processes from fetching at the same time.
 * Best-effort — if the fetch fails, the subsequent browser launch surfaces the
 * existing actionable "run npx camoufox fetch" error rather than this throwing.
 */
export function ensureBrowserInstalled(): Promise<void> {
  if (!inFlight) {
    inFlight = provision().catch((err) => {
      // Reset so a later attempt (e.g. after the user fixes the network) can retry.
      inFlight = null;
      logger.warn(`[ensure-browser] Automatic browser provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return inFlight;
}
