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

const { execSync } = require('child_process');
const { existsSync, readdirSync, statSync } = require('fs');
const { homedir } = require('os');
const path = require('path');

// __dirname / __filename are built-in globals in CommonJS (.cjs) modules
const projectRoot = path.join(__dirname, '..');

const isLinux = process.platform === 'linux';
const isDarwin = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

const major = parseInt(process.version.replace('v', '').split('.')[0], 10);
if (major < 22) {
  console.warn(`WARNING: Node.js ${process.version} is below the minimum (22). Upgrade to 22.13.0+.`);
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
    const bin = path.join(binDir, 'camoufox-js');
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
      console.warn(`WARNING: could not install system dependencies. Run: sudo apt-get install -y xvfb libgbm1 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libxcomposite1\nReason: ${e instanceof Error ? e.message : String(e)}`);
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
      const cmd = bin ? `"${bin}" fetch` : 'npx camoufox-js fetch';
      execSync(cmd, { stdio: 'inherit', env });
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

// On Linux without a display server, Xvfb is required for browser automation.
// Print a one-time hint so new installs on TTY/Wayland machines know what to do.
if (isLinux && !process.env.DISPLAY) {
  console.log('pi-research: No display server detected (DISPLAY not set). For headless use on TTY or Wayland, install Xvfb: sudo apt install xvfb');
}
