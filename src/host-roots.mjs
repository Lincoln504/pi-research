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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
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
    // Absolute entries only: a relative one (`node_modules/.bin`, `.`) resolves against the
    // cwd, and a hostile checkout could plant a `pi` there that leads to ITS node_modules.
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * `npm root -g`, run from the home directory — never the cwd, which may be an untrusted
 * checkout. On Windows npm is a .cmd shim, and running it through cmd.exe would search the
 * cwd first (a planted npm.cmd would run); instead run npm's own script with the Node that is
 * already running us, no shell involved.
 */
function npmGlobalRoot() {
  try {
    let command = 'npm';
    let args = ['root', '-g'];
    if (process.platform === 'win32') {
      const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!existsSync(cli)) return null;
      command = process.execPath;
      args = [cli, 'root', '-g'];
    }
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 8000, cwd: homedir() });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
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
  // pi's own managed install (pi 1.x): ~/.pi/agent/install/releases/<current-version>/node_modules.
  // The `pi` on PATH is then a shell script, not a link into node_modules, so the lookup above
  // cannot see it.
  try {
    const agentDir = process.env['PI_CODING_AGENT_DIR'] || join(homedir(), '.pi', 'agent');
    const current = readFileSync(join(agentDir, 'install', 'current-version'), 'utf8').trim();
    if (/^[A-Za-z0-9._+-]+$/.test(current) && current !== '.' && current !== '..') {
      dirs.add(join(agentDir, 'install', 'releases', current, 'node_modules'));
    }
  } catch {
    /* no managed install */
  }
  // The global root of the Node that is running us, without spawning npm.
  dirs.add(join(dirname(process.execPath), '..', 'lib', 'node_modules'));
  dirs.add(join(dirname(process.execPath), 'node_modules'));
  dirs.add(join(homedir(), '.bun', 'install', 'global', 'node_modules'));
  if (spawnNpm) {
    const root = npmGlobalRoot();
    if (root) dirs.add(root);
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
