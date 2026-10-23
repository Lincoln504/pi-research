/**
 * Where the pi HOST's copies of the peer dependencies live, when they are not installed
 * beside this package.
 *
 * `pi install` runs npm with --legacy-peer-deps, so the managed install
 * (~/.pi/agent/npm) never contains @earendil-works/* or typebox: pi hands its own copies
 * to extension code in-process. The standalone engine (CLI, agent skill) is launched
 * through the bin shim in a plain Node process, where Node's ESM resolver walks up
 * node_modules directories only — it ignores NODE_PATH and the global root — so every
 * agent call died with "required runtime dependency ... is not installed alongside it",
 * and the advertised remedy (`npm install -g @earendil-works/pi-coding-agent`) could not
 * help: a global install is not on that resolution path either.
 *
 * This module finds the host's copies in the places pi is realistically installed, so the
 * shim can point the resolver at them (host-resolve-hook.mjs). Plain ESM with no imports
 * from this package: it is loaded by the unbundled shim before anything else, and bundled
 * into the agent-skill launcher.
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** The peer dependencies the engine imports at startup. */
export const HOST_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  'typebox',
];

const PI_CODING_AGENT = ['@earendil-works', 'pi-coding-agent'];

function binsOnPath(name) {
  const exts = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD').split(';') : [''];
  const out = [];
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * node_modules directories that may hold the host's packages, most specific first.
 * `spawnNpm` additionally asks npm for its global root (a process spawn, so it is only
 * done when the cheap candidates found nothing).
 */
export function candidateNodeModulesDirs({ spawnNpm = false } = {}) {
  const dirs = new Set();
  const explicit = process.env['PI_RESEARCH_HOST_DIR'];
  if (explicit) {
    dirs.add(explicit);
    dirs.add(join(explicit, 'node_modules'));
  }
  // The directory behind the `pi` command: <root>/node_modules/@earendil-works/pi-coding-agent/...
  for (const bin of binsOnPath('pi')) {
    try {
      const m = /^(.*[\\/]node_modules)[\\/]/.exec(realpathSync(bin));
      if (m) dirs.add(m[1]);
    } catch {
      /* dangling link: skip */
    }
  }
  // The global root of the Node that is running us, without spawning npm.
  dirs.add(join(dirname(process.execPath), '..', 'lib', 'node_modules'));
  dirs.add(join(dirname(process.execPath), 'node_modules'));
  dirs.add(join(homedir(), '.bun', 'install', 'global', 'node_modules'));
  if (spawnNpm) {
    try {
      const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
        encoding: 'utf8',
        timeout: 8000,
        shell: process.platform === 'win32',
      });
      if (r.status === 0 && r.stdout.trim()) dirs.add(r.stdout.trim());
    } catch {
      /* npm not on PATH */
    }
  }
  return [...dirs];
}

/** The node_modules directory holding `name`, searching the candidates (and pi's own nested deps). */
function locate(name, nodeModulesDirs) {
  for (const nm of nodeModulesDirs) {
    if (existsSync(join(nm, name, 'package.json'))) return nm;
    const nested = join(nm, ...PI_CODING_AGENT, 'node_modules');
    if (existsSync(join(nested, name, 'package.json'))) return nested;
  }
  return null;
}

/**
 * Locate every host package in `names` that the caller could not resolve itself.
 * @returns {{ found: Map<string, string>, missing: string[] }} name -> node_modules dir
 */
export function findHostPackages(names = HOST_PACKAGES) {
  const found = new Map();
  // Opt-out: insist on peers installed beside the engine (strict deployments, hermetic tests).
  if (process.env['PI_RESEARCH_NO_HOST_FALLBACK'] === '1') return { found, missing: [...names] };
  let pending = [...names];
  for (const spawnNpm of [false, true]) {
    if (pending.length === 0) break;
    const dirs = candidateNodeModulesDirs({ spawnNpm });
    pending = pending.filter((name) => {
      const nm = locate(name, dirs);
      if (nm) found.set(name, nm);
      return !nm;
    });
  }
  return { found, missing: pending };
}

/** Distinct node_modules directories from a findHostPackages() result. */
export function hostDirs(found) {
  return [...new Set(found.values())];
}
