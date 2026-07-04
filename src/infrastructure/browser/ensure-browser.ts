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
 * postinstall fetch — this is a cheap `existsSync` check that returns
 * immediately and changes nothing. It only ever does work when the binary is
 * genuinely absent.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync, fstatSync, openSync, closeSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../../logger.ts';
import { getCamoufoxBinaryPath } from './config.ts';

/** Bound the ~100MB download so a stalled network fails fast instead of hanging forever. */
const FETCH_TIMEOUT_MS = 15 * 60 * 1000;
/** A lock older than this is considered stale (crashed mid-fetch) and may be stolen. */
const STALE_LOCK_MS = 20 * 60 * 1000;
/** When another process holds the fetch lock, poll this long for the browser to appear. */
const WAIT_FOR_PEER_MS = 16 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

/** In-process dedupe: concurrent pool inits / scrapers share one fetch. */
let inFlight: Promise<void> | null = null;

/**
 * True when a camoufox browser binary is actually present (cache dir exists and
 * contains at least one version subdirectory) — mirrors the check in setup.cjs.
 */
export function isBrowserBinaryPresent(): boolean {
  try {
    const cacheDir = getCamoufoxBinaryPath();
    if (!existsSync(cacheDir)) return false;
    return readdirSync(cacheDir).some((entry) => {
      try {
        return statSync(join(cacheDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Resolve the camoufox-js CLI bin, mirroring scripts/setup.cjs (handles hoisting). */
function resolveCamoufoxBin(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('camoufox-js/package.json');
    const bin = join(dirname(pkgJson), '..', '.bin', process.platform === 'win32' ? 'camoufox-js.cmd' : 'camoufox-js');
    if (existsSync(bin)) return bin;
  } catch {
    /* fall through to npx */
  }
  return null;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `camoufox-js fetch`, resolving on exit 0 and rejecting otherwise / on timeout. */
function runFetch(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const bin = resolveCamoufoxBin();
    const [cmd, args] = bin ? [bin, ['fetch']] : ['npx', ['camoufox-js', 'fetch']];
    logger.info(`[ensure-browser] Camoufox not found; fetching the browser (this runs once, ~100MB): ${cmd} ${args.join(' ')}`);

    // Windows needs shell:true to run the .cmd shim (Node CVE-2024-27980 fix makes a
    // shell-less spawn of .cmd throw EINVAL), but shell:true performs NO quoting, so a
    // spaced install path (C:\Users\John Smith\…) must be quoted explicitly. The args
    // here are fixed literals ('fetch'), never user input, so quoting the command alone
    // is sufficient and this stays injection-free.
    const useShell = process.platform === 'win32';
    const child = spawn(useShell ? `"${cmd}"` : cmd, args, { stdio: 'inherit', shell: useShell });
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
      if (code === 0) resolve();
      else reject(new Error(`camoufox fetch exited with code ${code}`));
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
    await runFetch();
    if (isBrowserBinaryPresent()) {
      logger.info('[ensure-browser] Camoufox browser is ready.');
    } else {
      logger.warn('[ensure-browser] camoufox fetch reported success but no binary was found.');
    }
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
 * existing actionable "run npx camoufox-js fetch" error rather than this throwing.
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
