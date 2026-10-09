#!/usr/bin/env node

/**
 * pi-research postinstall setup.
 * Installs Camoufox browser binaries.
 *
 * Exits 0 on EVERY failure path, because a non-zero exit from postinstall makes
 * `npm install` fail and leaves the user without the package at all — the
 * browser is re-fetchable on first use, a failed install is not. The single
 * exception is PI_RESEARCH_STRICT_SETUP (set by this repo's CI), which restates
 * the failure as exit 1 so an install regression fails the build loudly instead
 * of hiding behind the graceful path.
 *
 * Environment:
 *   CAMOUFOX_INSTALL_DIR / PLAYWRIGHT_BROWSERS_PATH - relocate the browser cache (Linux: XDG_CACHE_HOME,
 *                                         Windows: LOCALAPPDATA; ignored on macOS)
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1  - skip download entirely
 *   PLAYWRIGHT_INSTALL_DEPS=true        - also install Linux system deps (or pass --system-deps)
 */

const { execSync, spawnSync } = require('child_process');
const { existsSync, readdirSync, statSync } = require('fs');
const { homedir } = require('os');
const path = require('path');

// __dirname / __filename are built-in globals in CommonJS (.cjs) modules
const projectRoot = path.join(__dirname, '..');

const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

const [nodeMajor, nodeMinor, nodePatch] = process.version.replace('v', '').split('.').map((n) => parseInt(n, 10));
// Minimum is 22.22.2 — the floor `jsdom` 30 (a runtime dependency) and npm 12 both declare.
const belowMinimum =
  nodeMajor < 22 || (nodeMajor === 22 && (nodeMinor < 22 || (nodeMinor === 22 && nodePatch < 2)));
if (belowMinimum) {
  console.warn(`WARNING: Node.js ${process.version} is below the minimum (>=22.22.2). Upgrade to 22.22.2+.`);
}

const layout = require('./camoufox-layout.cjs');

/**
 * Resolve the `camoufox` CLI entry of @camoufox/camoufox.
 *
 * Dependencies are hoisted, so the package's own node_modules may be empty:
 * require.resolve finds the real location. We run the CLI's JS entry with
 * process.execPath instead of the .bin shim: no .cmd quoting on Windows, no
 * shell, and an argv array that cannot be reinterpreted.
 */
function resolveCamoufoxCli() {
  try {
    const pkgJson = require.resolve('@camoufox/camoufox/package.json', { paths: [projectRoot] });
    const pkg = require(pkgJson);
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.camoufox;
    if (rel) {
      const entry = path.join(path.dirname(pkgJson), rel);
      if (existsSync(entry)) return entry;
    }
  } catch (_) { /* fall through */ }
  return null;
}

let browsersInstalled = false;
// Set when a fetch cannot possibly succeed (an unusable configured install dir),
// so the download is skipped rather than run to completion and then fail. Kept
// separate from browsersInstalled so the summary below still tells the truth.
let fetchSkipped = false;

// @camoufox/camoufox derives its install dir ONLY from the platform cache location
// and ignores CAMOUFOX_INSTALL_DIR / PLAYWRIGHT_BROWSERS_PATH. The layout module turns
// a user's custom dir into the variable it does read (XDG_CACHE_HOME / LOCALAPPDATA).
// The same function runs at runtime (src/infrastructure/browser/config.ts), so the
// install and the lookup cannot disagree.
const install = layout.resolveInstall(process.env, process.platform, homedir());
const cachePath = install.dir;
if (install.ignoredCustom) {
  console.warn(
    `pi-research: CAMOUFOX_INSTALL_DIR / PLAYWRIGHT_BROWSERS_PATH (${install.custom}) is ignored on macOS: ` +
    `the Camoufox launcher always uses ${cachePath} and cannot be relocated without moving HOME.`,
  );
}

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
  console.log('pi-research: skipping browser download (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)');
} else {
  const env = { ...process.env, ...install.overrides };
  delete env.CAMOUFOX_INSTALL_DIR;
  delete env.PLAYWRIGHT_BROWSERS_PATH;

  const installDeps = process.argv.includes('--system-deps') || process.env.PLAYWRIGHT_INSTALL_DEPS === 'true';
  if (installDeps && isLinux) {
    try {
      // Use the installed playwright-core CLI, NOT `npx playwright`: `playwright`
      // is not a dependency of this package (only `playwright-core` is), so
      // `npx playwright` resolved a DIFFERENT, unpinned package from the registry
      // at install time — an extra network fetch, an extra supply-chain surface,
      // and a version that can disagree with the browser we drive. playwright-core
      // ships the same `install-deps` subcommand (verified: its CLI lists it).
      const playwrightCoreBin = path.join(projectRoot, 'node_modules', '.bin', isWindows ? 'playwright-core.cmd' : 'playwright-core');
      const cli = existsSync(playwrightCoreBin) ? playwrightCoreBin : 'playwright-core';
      execSync(`"${cli}" install-deps`, { stdio: 'inherit', env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0' } });
    } catch (e) {
      console.warn(`WARNING: could not install system dependencies. Run: sudo apt-get install -y libgbm1 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libxcomposite1\nReason: ${e instanceof Error ? e.message : String(e)}\n(These are the libraries headless camoufox needs. Xvfb is NOT required for the default headless mode — only add it if you opt into virtual-display mode with PI_RESEARCH_USE_XVFB=true.)`);
    }
  }

  // A configured install dir whose parent exists but cannot be used as a directory (a
  // plain file, a broken mount) makes the fetch impossible: it would download the whole
  // ~1.3GB archive and then fail to place it. Report and skip instead.
  if (install.custom && existsSync(install.custom)) {
    try {
      if (!statSync(install.custom).isDirectory()) throw new Error('not a directory');
      readdirSync(install.custom);
    } catch (e) {
      console.warn(`pi-research: cannot use the browser install directory ${install.custom}: ${e instanceof Error ? e.message : String(e)}`);
      console.warn('pi-research: skipping the browser fetch because CAMOUFOX_INSTALL_DIR / PLAYWRIGHT_BROWSERS_PATH points at a path that is not a usable directory. Fix or unset it, then run: npx camoufox fetch');
      fetchSkipped = true;
    }
  }

  if (!fetchSkipped) {
    const cli = resolveCamoufoxCli();
    // The fetch runs through process.execPath with an ARGV ARRAY, never a shell string:
    // `cli` is a filesystem path derived from the install directory, and a shell string
    // would let a directory name containing `$(…)` execute at install time. The runtime
    // twin in ensure-browser.ts uses the same shape.
    // Bound the ~1.3GB browser download so a stalled network fails eventually instead of
    // hanging `npm install` forever (the failure path below exits 0 and the browser is
    // re-fetchable). 45 min covers a working link down to ~500 KB/s.
    const runFetch = () => {
      if (!cli) throw new Error('@camoufox/camoufox is not installed (cannot find its CLI)');
      const res = spawnSync(process.execPath, [cli, 'fetch'], { stdio: 'inherit', env, timeout: 45 * 60 * 1000 });
      if (res.error) throw res.error;
      if (res.status !== 0) throw new Error(`camoufox fetch exited with code ${res.status}`);
      return true;
    };

    console.log('pi-research: downloading the ~1.3 GB Camoufox browser — this can take several minutes on a slow link…');
    const pkgRoot = layout.findPackageRoot(projectRoot);
    const result = layout.provisionBrowser(cachePath, runFetch, (m) => console.log(m), pkgRoot ? layout.loadPin(pkgRoot) : null);
    if (result.status === 'failed') {
      console.error('ERROR: Camoufox browser install failed — pi-research will not work.');
      console.error('Run manually to fix: npx camoufox fetch');
      console.error(`Reason: ${result.reason}`);
      // Exit 0 by default: the browser is fetched lazily on first use, so a restrictive
      // network must not fail a user's install. But that also meant nothing here could
      // ever turn CI red — a broken Windows launcher yielded a green `npm ci`. CI sets
      // PI_RESEARCH_STRICT_SETUP=1 so the platform-specific spawn paths above are
      // actually enforced somewhere.
      const strict = process.env.PI_RESEARCH_STRICT_SETUP === '1' ||
                     process.env.PI_RESEARCH_STRICT_SETUP === 'true';
      process.exit(strict ? 1 : 0);
    }
    browsersInstalled = true;
    if (result.status === 'present') {
      console.log(`pi-research: Camoufox already installed at ${cachePath}. Skipping fetch.`);
    }
  }
}

// Verify
if (existsSync(cachePath)) {
  const builds = layout.listInstalls(cachePath).map((b) => b.name);
  const pkgRootForVerify = layout.findPackageRoot(projectRoot);
  if (builds.length > 0 && layout.isUsable(cachePath, pkgRootForVerify ? layout.loadPin(pkgRootForVerify) : null)) {
    console.log(`pi-research: camoufox ready (${builds.join(', ')})`);
  } else if (browsersInstalled) {
    console.warn(`pi-research: camoufox install at ${cachePath} could not be verified (no usable browser build found)`);
  }
} else if (browsersInstalled) {
  console.warn(`pi-research: camoufox binary not found at expected path ${cachePath}`);
}

// On Linux without a display server the browser runs true-headless (renders
// offscreen, no Xvfb required) — nothing to install. Xvfb is only needed if you
// opt into the virtual-framebuffer mode with PI_RESEARCH_USE_XVFB=true.
if (isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.log('pi-research: No display server detected — the browser will run headless (no Xvfb needed). To opt into Xvfb virtual-display mode, set PI_RESEARCH_USE_XVFB=true and install it: sudo apt install xvfb');
}
