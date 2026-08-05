#!/usr/bin/env node

/**
 * pi-research postinstall setup.
 * Installs Camoufox browser binaries.
 * Never exits with code 1 — that would break npm install.
 *
 * Environment:
 *   PLAYWRIGHT_BROWSERS_PATH            - override browser install location
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
const isDarwin = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

const [nodeMajor, nodeMinor] = process.version.replace('v', '').split('.').map((n) => parseInt(n, 10));
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
  console.warn(`WARNING: Node.js ${process.version} is below the minimum (>=22.19.0). Upgrade to 22.19.0+.`);
}

/**
 * Resolve the camoufox-js binary path.
 *
 * In a typical npm install, dependencies are hoisted to the root node_modules,
 * so the package's own node_modules/ may be empty. We use require.resolve to
 * find the real location of camoufox-js and derive the bin from there.
 */
function resolveCamoufoxBin() {
  try {
    const pkgDir = path.dirname(require.resolve('camoufox-js/package.json', { paths: [projectRoot] }));
    const binDir = path.join(pkgDir, '..', '.bin');
    // On Windows the executable is the .cmd shim; the extensionless file is a sh
    // script that only runs via PATHEXT luck. Mirror src ensure-browser.ts.
    const bin = path.join(binDir, isWindows ? 'camoufox-js.cmd' : 'camoufox-js');
    if (existsSync(bin)) return bin;
  } catch (_) { /* fall through */ }
  return null;
}

function camoufoxCachePath() {
  const customPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (customPath) return customPath;

  if (isWindows) {
    // Mirror camoufox-js userCacheDir("camoufox") exactly: homedir-based with a
    // DOUBLED "camoufox" segment. Must match src getWindowsCamoufoxDir().
    return path.join(homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache');
  }
  if (isDarwin) return path.join(homedir(), 'Library', 'Caches', 'camoufox');
  
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
  return path.join(cacheHome, 'camoufox');
}

let browsersInstalled = false;

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
  console.log('pi-research: skipping browser download (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)');
} else {
  const env = { ...process.env };

  const installDeps = process.argv.includes('--system-deps') || process.env.PLAYWRIGHT_INSTALL_DEPS === 'true';
  if (installDeps && isLinux) {
    try {
      execSync('npx playwright install-deps', { stdio: 'inherit', env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0' } });
    } catch (e) {
      console.warn(`WARNING: could not install system dependencies. Run: sudo apt-get install -y libgbm1 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libxcomposite1\nReason: ${e instanceof Error ? e.message : String(e)}\n(These are the libraries headless camoufox needs. Xvfb is NOT required for the default headless mode — only add it if you opt into virtual-display mode with PI_RESEARCH_USE_XVFB=true.)`);
    }
  }

  const cachePath = camoufoxCachePath();
  let alreadyInstalled = false;
  if (existsSync(cachePath)) {
    try {
      const versions = readdirSync(cachePath).filter(f => statSync(path.join(cachePath, f)).isDirectory());
      if (versions.length > 0) {
        alreadyInstalled = true;
        console.log(`pi-research: Camoufox already installed at ${cachePath}. Skipping fetch.`);
      }
    } catch (e) {
      console.warn(`pi-research: error checking camoufox path ${cachePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!alreadyInstalled) {
    try {
      const bin = resolveCamoufoxBin();
      // spawnSync with an ARGV ARRAY, never a shell string. `bin` is a filesystem
      // path derived from the install directory, and execSync runs through
      // `/bin/sh -c` where `$(…)`, backticks and quotes stay live INSIDE double
      // quotes — so a package installed under a directory whose name contains
      // shell metacharacters would execute them at install time. Windows still
      // needs a shell to run the `.cmd` shim, and there the path is quoted; the
      // runtime twin in ensure-browser.ts uses the same shape.
      // Bound the ~100MB download so a stalled/interrupted network fails fast
      // instead of hanging `npm install` forever (the catch below exits 0, and the
      // browser is re-fetchable manually). 15 min is ample even on slow links.
      const spawnOpts = { stdio: 'inherit', env, timeout: 15 * 60 * 1000 };
      const res = bin
        ? (isWindows
            ? spawnSync(`"${bin}"`, ['fetch'], { ...spawnOpts, shell: true })
            : spawnSync(bin, ['fetch'], spawnOpts))
        : spawnSync('npx', ['camoufox-js', 'fetch'], { ...spawnOpts, shell: isWindows });
      if (res.error) throw res.error;
      if (res.status !== 0) throw new Error(`camoufox fetch exited with code ${res.status}`);
      browsersInstalled = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('ERROR: Camoufox browser install failed — pi-research will not work.');
      console.error('Run manually to fix: npx camoufox-js fetch');
      console.error(`Reason: ${msg}`);
      process.exit(0);
    }
  } else {
    browsersInstalled = true;
  }
}

// Verify
const cachePath = camoufoxCachePath();
if (existsSync(cachePath)) {
  try {
    const versions = readdirSync(cachePath).filter(f => statSync(path.join(cachePath, f)).isDirectory());
    console.log(`pi-research: camoufox ready (${versions.join(', ') || 'installed'})`);
  } catch (e) {
    console.log(`pi-research: camoufox ready (path check error: ${e instanceof Error ? e.message : String(e)})`);
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
