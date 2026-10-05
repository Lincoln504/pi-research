'use strict';

/**
 * Camoufox install-layout helpers shared by scripts/setup.cjs and scripts/cleanup.cjs.
 *
 * TWIN of src/infrastructure/browser/camoufox-layout.ts (the runtime half). The two
 * are kept line-for-line equivalent on purpose and test/unit/infrastructure/
 * camoufox-layout.test.ts runs both against the same fixtures, because a drift
 * between "where setup installed it" and "where the runtime looks" is exactly the
 * install/runtime mismatch this package has shipped before.
 *
 * Why this exists. `@camoufox/camoufox` (0.5.x) differs from the old `camoufox-js`:
 *   - It installs under  <INSTALL_DIR>/browsers/<repo>/<version>/  (multi-version),
 *     with `config.json`, `repo_cache.json` and a `.0.5_FLAG` beside it. camoufox-js
 *     put the browser files FLAT in INSTALL_DIR with a root `version.json`.
 *   - INSTALL_DIR is derived ONLY from platform cache dirs (XDG_CACHE_HOME on Linux,
 *     LOCALAPPDATA on Windows, $HOME/Library/Caches on macOS). It does NOT read
 *     CAMOUFOX_INSTALL_DIR or PLAYWRIGHT_BROWSERS_PATH.
 *   - `camoufox fetch` does `rm -rf INSTALL_DIR` when it is non-empty and has no
 *     `.0.5_FLAG` ("Cleaning old data...") BEFORE it downloads anything, so a failed
 *     download over a legacy install leaves the user with no browser at all.
 *   - A newer pi-research release that pins a newer browser installs the new build
 *     beside the old one and never removes it; the old one is dead weight because a
 *     released library only ever launches its own pinned build.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const COMPAT_FLAG = '.0.5_FLAG';

/** Names whose presence, with a root version.json, proves a legacy camoufox-js install. */
const LEGACY_MARKERS = ['camoufox-bin', 'camoufox', 'camoufox.exe', 'application.ini', 'Camoufox.app', 'properties.json'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/** The custom location the user asked for, if any (camoufox itself ignores both variables). */
function customDir(env = process.env) {
  return env.CAMOUFOX_INSTALL_DIR || env.PLAYWRIGHT_BROWSERS_PATH || null;
}

/** Mirrors @camoufox/camoufox paths.js userCacheDir('camoufox') for a given environment. */
function defaultInstallDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : path.join(home, 'AppData', 'Local');
    return path.join(base, 'camoufox', 'camoufox', 'Cache');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'camoufox');
  const xdg = (env.XDG_CACHE_HOME || '').trim();
  return path.join(xdg ? xdg : path.join(home, '.cache'), 'camoufox');
}

/**
 * Resolve where the browser lives and which env overrides make camoufox use it.
 *
 *  - No custom dir:  the platform default, no overrides.
 *  - Linux:   custom is the cache HOME (XDG_CACHE_HOME=custom, browser in custom/camoufox),
 *             except when custom already ends in `camoufox`, where its parent becomes the
 *             cache home so the browser lives in custom itself (old camoufox-js semantics).
 *  - Windows: same idea through LOCALAPPDATA (browser in <base>\camoufox\camoufox\Cache).
 *  - macOS:   camoufox derives the cache from $HOME only; relocating it would mean
 *             redirecting HOME for the browser process, which also moves Firefox's own
 *             state. The custom dir is ignored there (`ignoredCustom` is set so callers can say so).
 */
function resolveInstall(env = process.env, platform = process.platform, home = os.homedir()) {
  const custom = customDir(env);
  if (!custom) return { dir: defaultInstallDir(env, platform, home), overrides: {}, custom: null, ignoredCustom: false };
  if (platform === 'darwin') {
    return { dir: defaultInstallDir(env, platform, home), overrides: {}, custom, ignoredCustom: true };
  }
  const resolved = (platform === 'win32' ? path.win32 : path).resolve(custom);
  if (platform === 'win32') {
    // <LOCALAPPDATA>\camoufox\camoufox\Cache : one fixed shape, custom = LOCALAPPDATA.
    const overrides = { LOCALAPPDATA: resolved };
    return { dir: defaultInstallDir({ ...env, ...overrides }, platform, home), overrides, custom, ignoredCustom: false };
  }
  const endsInCamoufox = path.basename(resolved).toLowerCase() === 'camoufox';
  const cacheHome = endsInCamoufox ? path.dirname(resolved) : resolved;
  const overrides = { XDG_CACHE_HOME: cacheHome };
  return { dir: defaultInstallDir({ ...env, ...overrides }, platform, home), overrides, custom, ignoredCustom: false };
}

/** Every `browsers/<repo>/<version>/` directory that holds a parseable version.json. */
function listInstalls(dir) {
  const out = [];
  const browsers = path.join(dir, 'browsers');
  let repos = [];
  try {
    repos = fs.readdirSync(browsers, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const repo of repos) {
    if (!repo.isDirectory() || repo.name.startsWith('.')) continue;
    const repoDir = path.join(browsers, repo.name);
    let versions = [];
    try {
      versions = fs.readdirSync(repoDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const v of versions) {
      if (!v.isDirectory()) continue;
      const vdir = path.join(repoDir, v.name);
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(vdir, 'version.json'), 'utf8'));
      } catch (_) {
        continue; // missing/corrupt version.json: the library skips it too
      }
      out.push({
        repo: repo.name,
        name: v.name,
        path: vdir,
        rel: `browsers/${repo.name}/${v.name}`,
        version: meta && typeof meta.version === 'string' ? meta.version : '',
        build: meta && typeof meta.build === 'string' ? meta.build : '',
      });
    }
  }
  return out;
}

/** True when the NEW layout holds at least one usable browser version. */
function hasInstall(dir) {
  return listInstalls(dir).length > 0;
}

/**
 * Proof that `dir` is a legacy flat camoufox-js install: a root version.json carrying
 * `version` + `release`, no `.0.5_FLAG`, and at least one file only a camoufox build has.
 * Anything short of that is NOT claimed, so it is never removed or moved.
 */
function isLegacyFlat(dir) {
  if (!isDir(dir) || isFile(path.join(dir, COMPAT_FLAG))) return false;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
  } catch (_) {
    return false;
  }
  if (!meta || typeof meta.version !== 'string' || typeof meta.release !== 'string') return false;
  return LEGACY_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * Whether `dir` is provably camoufox's own install dir (new or legacy layout, or the
 * empty shell camoufox leaves behind). Used as the guard before any recursive delete.
 */
function isCamoufoxDir(dir) {
  if (!isDir(dir)) return false;
  if (isFile(path.join(dir, COMPAT_FLAG))) return true;
  if (hasInstall(dir)) return true;
  if (isLegacyFlat(dir)) return true;
  return false;
}

/** True when the user chose a channel/pin themselves (camoufox then honours it, so keep their versions). */
function hasExplicitChoice(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return Boolean(cfg && (cfg.pinned || cfg.channel));
  } catch (_) {
    return false;
  }
}

/**
 * The browser build @camoufox/camoufox was released with, from its browser-pin.json
 * (`{ repoName, version, build }`, repoName lowercased), or null when unpinned/unreadable.
 * `packageRoot` is the directory of the @camoufox/camoufox package.
 */
function loadPin(packageRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(packageRoot, 'dist', 'data-files', 'browser-pin.json'), 'utf8'));
    if (!data || !data.tag) return null;
    return { repoName: String(data.repo_name).toLowerCase(), version: String(data.version), build: String(data.build) };
  } catch (_) {
    return null;
  }
}

/** The @camoufox/camoufox package directory as seen from `fromDir`, or null. */
function findPackageRoot(fromDir) {
  try {
    return path.dirname(require.resolve('@camoufox/camoufox/package.json', { paths: [fromDir] }));
  } catch (_) {
    return null;
  }
}

/** Whether `build` is the one `pin` names. */
function matchesPin(build, pin) {
  return build.repo.toLowerCase() === pin.repoName && build.version === pin.version && build.build === pin.build;
}

/**
 * Remove every installed version except the one the library will launch: the paired
 * build when `pin` is given and the user made no explicit choice, otherwise the active one. A released camoufox launches
 * only the build it was released with, so superseded builds are pure disk weight.
 * Does nothing when the user made an explicit `camoufox set` choice, when there is no
 * identifiable active version, or when the active version's folder is missing.
 * Returns the removed relative paths.
 */
function pruneSuperseded(dir, log = () => {}, pin = null) {
  if (hasExplicitChoice(dir)) return [];
  const installs = listInstalls(dir);
  let keep = null;
  if (pin) {
    const paired = installs.find((i) => matchesPin(i, pin));
    keep = paired ? paired.rel : null;
  } else {
    try {
      keep = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).active_version || null;
    } catch (_) {
      return [];
    }
  }
  if (!keep || !installs.some((i) => i.rel === keep)) return [];
  const removed = [];
  for (const i of installs) {
    if (i.rel === keep) continue;
    try {
      fs.rmSync(i.path, { recursive: true, force: true });
      removed.push(i.rel);
      log(`pi-research: removed superseded Camoufox build ${i.rel}`);
    } catch (e) {
      log(`pi-research: could not remove superseded Camoufox build ${i.rel}: ${e && e.message ? e.message : e}`);
    }
  }
  // Drop now-empty repo folders so listings stay clean.
  try {
    for (const r of fs.readdirSync(path.join(dir, 'browsers'))) {
      const rd = path.join(dir, 'browsers', r);
      if (isDir(rd) && fs.readdirSync(rd).length === 0) fs.rmdirSync(rd);
    }
  } catch (_) { /* best effort */ }
  return removed;
}

/**
 * Move a PROVEN legacy flat install out of the way so `camoufox fetch` (which would
 * rm -rf it before downloading) cannot destroy a working browser if the download fails.
 * Returns the stash path, or null when `dir` is not a provable legacy install.
 */
function stashLegacy(dir) {
  if (!isLegacyFlat(dir)) return null;
  const stash = `${dir}.legacy-${process.pid}-${Date.now()}`;
  fs.renameSync(dir, stash);
  return stash;
}

/** Put a stashed legacy install back (download failed). */
function restoreLegacy(dir, stash) {
  if (!stash || !fs.existsSync(stash)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* partial new dir; best effort */ }
  fs.renameSync(stash, dir);
}

/** Delete a stashed legacy install (new layout verified usable). */
function discardLegacy(stash) {
  if (!stash) return;
  fs.rmSync(stash, { recursive: true, force: true });
}

/** Leftover legacy stash dirs from a crashed run next to `dir`; deleted only when the new layout is usable. */
function sweepStaleStashes(dir, log = () => {}) {
  if (!hasInstall(dir)) return [];
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.legacy-`;
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(parent);
  } catch (_) {
    return removed;
  }
  for (const e of entries) {
    if (!e.startsWith(prefix)) continue;
    const p = path.join(parent, e);
    if (!isLegacyFlat(p)) continue;
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
      log(`pi-research: removed leftover legacy Camoufox stash ${p}`);
    } catch (_) { /* best effort */ }
  }
  return removed;
}

/**
 * Remove the whole install dir, but only when it is provably camoufox's own.
 * Returns 'removed' | 'absent' | 'refused'.
 */
function removeInstallDir(dir) {
  if (!fs.existsSync(dir)) return 'absent';
  if (!isCamoufoxDir(dir)) return 'refused';
  fs.rmSync(dir, { recursive: true, force: true });
  return 'removed';
}

/** True when the NEW layout can launch: the compat flag plus the paired build (or any build when unpinned). */
function isUsable(dir, pin = null) {
  if (!isFile(path.join(dir, COMPAT_FLAG))) return false;
  const installs = listInstalls(dir);
  if (installs.length === 0) return false;
  // A released library launches ONLY its paired build (unless the user chose one with
  // `camoufox set`), and downloads it itself if absent. So "usable" means the paired
  // build is there, which makes an upgrade to a new pin re-fetch centrally instead of in
  // every worker at once.
  if (pin && !hasExplicitChoice(dir)) return installs.some((i) => matchesPin(i, pin));
  return true;
}

/** Stash dirs (`<dir>.legacy-<pid>-<ts>`) left beside `dir`, newest first, each proven legacy. */
function listStashes(dir) {
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.legacy-`;
  let entries = [];
  try {
    entries = fs.readdirSync(parent);
  } catch (_) {
    return [];
  }
  return entries
    .filter((e) => e.startsWith(prefix))
    .map((e) => path.join(parent, e))
    .filter((p) => isLegacyFlat(p))
    .sort()
    .reverse();
}

/**
 * Crash recovery: a previous run moved a legacy install aside and died before the
 * new build landed. If `dir` is now absent/empty and a proven legacy stash exists,
 * put it back so the user is not left without a browser. Returns the restored stash or null.
 */
function recoverStash(dir, log = () => {}) {
  let empty = !fs.existsSync(dir);
  if (!empty) {
    try {
      empty = isDir(dir) && fs.readdirSync(dir).length === 0;
    } catch (_) {
      return null;
    }
  }
  if (!empty) return null;
  const stash = listStashes(dir)[0];
  if (!stash) return null;
  try {
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
    fs.renameSync(stash, dir);
    log(`pi-research: restored the previous Camoufox install from ${stash}`);
    return stash;
  } catch (_) {
    return null;
  }
}

/**
 * Install the pinned browser without ever leaving the user with less than they had.
 *
 * `camoufox fetch` (and the library's own first launch) run `rm -rf <dir>` on a
 * non-empty dir that has no compat flag, i.e. on every legacy flat install, BEFORE
 * downloading. So a legacy install is moved aside first, the fetch runs against a clean
 * dir, and the stash is deleted only after the new layout verifies usable; any failure
 * restores it. `fetch` is `() => boolean` (true = exited 0).
 *
 * Returns { status: 'present' | 'installed' | 'failed', pruned: string[], reason? }.
 */
function provisionBrowser(dir, fetch, log = () => {}, pin = null) {
  recoverStash(dir, log);
  if (isUsable(dir, pin)) {
    sweepStaleStashes(dir, log);
    return { status: 'present', pruned: pruneSuperseded(dir, log, pin) };
  }
  let stash = null;
  try {
    stash = stashLegacy(dir);
  } catch (e) {
    // Could not move it (in use on Windows, permissions): fetching now would delete it.
    return { status: 'failed', pruned: [], reason: `could not move the existing legacy install aside (${e && e.message ? e.message : e}); left untouched` };
  }
  if (stash) log(`pi-research: legacy Camoufox install moved aside to ${stash} until the new browser is verified`);
  let ok = false;
  let reason;
  try {
    ok = fetch() === true;
    if (!ok) reason = 'camoufox fetch did not exit 0';
  } catch (e) {
    reason = e && e.message ? e.message : String(e);
  }
  if (ok && isUsable(dir, pin)) {
    discardLegacy(stash);
    if (stash) log('pi-research: removed the legacy Camoufox install (replaced by the new build)');
    sweepStaleStashes(dir, log);
    return { status: 'installed', pruned: pruneSuperseded(dir, log, pin) };
  }
  if (ok) reason = 'camoufox fetch exited 0 but no usable build was found';
  restoreLegacy(dir, stash);
  if (stash) log('pi-research: restored the previous Camoufox install after a failed upgrade');
  return { status: 'failed', pruned: [], reason };
}

module.exports = {
  COMPAT_FLAG,
  customDir,
  defaultInstallDir,
  resolveInstall,
  listInstalls,
  hasInstall,
  isLegacyFlat,
  isCamoufoxDir,
  hasExplicitChoice,
  pruneSuperseded,
  stashLegacy,
  restoreLegacy,
  discardLegacy,
  sweepStaleStashes,
  removeInstallDir,
  isUsable,
  loadPin,
  findPackageRoot,
  matchesPin,
  listStashes,
  recoverStash,
  provisionBrowser,
};
