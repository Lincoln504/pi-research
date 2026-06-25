#!/usr/bin/env node

const { execSync } = require('child_process');
const { rmSync, existsSync, lstatSync, readlinkSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
const os = require('os');
const path = require('path');

// __dirname is a built-in global in CommonJS (.cjs) modules
const projectRoot = path.join(__dirname, '..');

/**
 * Remove research-skill installs (symlinks/copies) this package created in the
 * coding-agent harnesses, so `npm uninstall` is symmetric with `install-skill`.
 * Reads the manifest written by the installer and removes ONLY entries we still
 * own (a symlink pointing into a pi-research skills dir, or a copy carrying our
 * package marker). Foreign directories are never touched. Best-effort; never
 * throws (preuninstall must not fail the uninstall).
 */
function removeInstalledSkills() {
  const manifestPath = path.join(os.homedir(), '.pi', 'research', 'installed-skills.json');
  if (!existsSync(manifestPath)) return;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return;
  }
  const entries = Array.isArray(manifest && manifest.entries) ? manifest.entries : [];
  const kept = [];
  for (const e of entries) {
    const p = e && e.path;
    if (!p) continue;
    // Use lstat, not existsSync: existsSync follows symlinks, so a DANGLING
    // symlink (our target already removed) reports absent and we'd drop the
    // manifest entry while leaving the broken symlink on disk. lstat sees the
    // link itself.
    let lst;
    try { lst = lstatSync(p); } catch { continue; } // truly gone → drop entry
    let owned = false;
    try {
      if (lst.isSymbolicLink()) {
        const dest = path.resolve(path.dirname(p), readlinkSync(p));
        owned = /[/\\]pi-research[/\\]skills[/\\]research$/.test(dest);
      } else {
        const md = readFileSync(path.join(p, 'SKILL.md'), 'utf-8');
        owned = md.includes('@lincoln504/pi-research');
      }
    } catch { /* treat as not-owned */ }
    if (!owned) { kept.push(e); continue; }
    try {
      if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
      else rmSync(p, { recursive: true, force: true });
      console.log(`pi-research: removed skill install at ${p}`);
    } catch (err) {
      kept.push(e);
      console.warn(`pi-research: could not remove skill install ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    if (kept.length > 0) {
      writeFileSync(manifestPath, JSON.stringify({ version: 1, package: '@lincoln504/pi-research', entries: kept }, null, 2) + '\n', 'utf-8');
    } else {
      unlinkSync(manifestPath);
    }
  } catch { /* best effort */ }
}

removeInstalledSkills();

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
