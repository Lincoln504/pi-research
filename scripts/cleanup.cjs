#!/usr/bin/env node

const { execSync } = require('child_process');
const { rmSync, existsSync } = require('fs');
const path = require('path');

// __dirname is a built-in global in CommonJS (.cjs) modules
const projectRoot = path.join(__dirname, '..');

/**
 * Resolve the camoufox-js binary path.
 *
 * See setup.cjs for rationale — dependencies are hoisted to root node_modules.
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

// Remove camoufox browser binaries — only when explicitly requested.
// The shared cache (~/.cache/camoufox) may be used by other tools, so we do NOT
// purge it by default. Set PI_RESEARCH_PURGE_BROWSERS=1 to opt in.
if (process.env.PI_RESEARCH_PURGE_BROWSERS === '1') {
  if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD !== '1') {
    try {
      const bin = resolveCamoufoxBin();
      const cmd = bin ? `"${bin}" remove` : 'npx camoufox-js remove';
      execSync(cmd, { stdio: 'inherit' });
      console.log('pi-research: camoufox browser binaries removed.');
    } catch (error) {
      console.warn(`pi-research: could not remove camoufox binaries: ${error instanceof Error ? error.message : String(error)}`);
      console.warn('pi-research: to remove manually, run: npx camoufox-js remove');
    }
  }
} else {
  console.log('pi-research: leaving shared camoufox binaries in place (set PI_RESEARCH_PURGE_BROWSERS=1 to remove).');
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
