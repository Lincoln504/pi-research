#!/usr/bin/env node

const { execSync } = require('child_process');
const { rmSync, existsSync } = require('fs');
const path = require('path');

// __dirname is a built-in global in CommonJS (.cjs) modules
const projectRoot = path.join(__dirname, '..');

// Remove camoufox browser binaries via the official CLI
if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD !== '1') {
  try {
    const bin = path.join(projectRoot, 'node_modules', '.bin', 'camoufox-js');
    const cmd = existsSync(bin) ? `"${bin}" remove` : 'npx camoufox-js remove';
    execSync(cmd, { stdio: 'inherit' });
    console.log('pi-research: camoufox browser binaries removed.');
  } catch (error) {
    console.warn(`pi-research: could not remove camoufox binaries: ${error instanceof Error ? error.message : String(error)}`);
    console.warn('pi-research: to remove manually, run: npx camoufox-js remove');
  }
}

// Remove legacy project-local browser cache if present
const legacyCacheDir = path.join(projectRoot, '.browser');
if (existsSync(legacyCacheDir)) {
  try {
    rmSync(legacyCacheDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`pi-research: could not remove ${legacyCacheDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(0);
