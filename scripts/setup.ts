#!/usr/bin/env node

/**
 * pi-research postinstall setup.
 * Installs Camoufox browser binaries.
 * Never exits with code 1 — that would break npm install.
 *
 * Environment:
 *   PLAYWRIGHT_BROWSERS_PATH       - override browser install location
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1  - skip download entirely
 *   PLAYWRIGHT_INSTALL_DEPS=true   - also install Linux system deps (or pass --system-deps)
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const isLinux = platform() === 'linux';
const isDarwin = platform() === 'darwin';
const isWindows = platform() === 'win32';

const nodeVersion = process.version.replace('v', '');
const [major] = nodeVersion.split('.').map(Number);
if (major < 22) {
  console.warn(`WARNING: Node.js ${nodeVersion} is below the minimum (22). Upgrade to 22.13.0+.`);
}

let browsersInstalled = false;

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
  console.log('pi-research: skipping browser download (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)');
} else {
  const env = {
    ...process.env,
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {})
  };

  const installDeps = process.argv.includes('--system-deps') || process.env.PLAYWRIGHT_INSTALL_DEPS === 'true';
  if (installDeps && isLinux) {
    try {
      execSync('npx playwright install-deps', { stdio: 'inherit', env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0' } });
    } catch {
      console.warn('WARNING: could not install system dependencies. Run: sudo apt-get install -y libgbm1 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libxcomposite1');
    }
  }

  try {
    const camoufoxBin = join(projectRoot, 'node_modules', '.bin', 'camoufox-js');
    const cmd = existsSync(camoufoxBin) ? `"${camoufoxBin}" fetch` : 'npx camoufox-js fetch';
    execSync(cmd, { stdio: 'inherit', env });
    browsersInstalled = true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('ERROR: Camoufox browser install failed — pi-research will not work.');
    console.error('Run manually to fix: npx camoufox-js fetch');
    console.error(`Reason: ${msg}`);
    process.exit(0);
  }
}

// Verify
const camoufoxBase = process.env.PLAYWRIGHT_BROWSERS_PATH || homedir();
const camoufoxPath = isWindows
  ? join(camoufoxBase, 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
  : isDarwin
    ? join(camoufoxBase, 'Library', 'Caches', 'camoufox')
    : join(camoufoxBase, '.cache', 'camoufox');

if (existsSync(camoufoxPath)) {
  try {
    const versions = readdirSync(camoufoxPath).filter(f => statSync(join(camoufoxPath, f)).isDirectory());
    console.log(`pi-research: camoufox ready (${versions.join(', ') || 'installed'})`);
  } catch {
    console.log('pi-research: camoufox ready');
  }
} else if (browsersInstalled) {
  console.warn(`pi-research: camoufox binary not found at expected path ${camoufoxPath}`);
}
