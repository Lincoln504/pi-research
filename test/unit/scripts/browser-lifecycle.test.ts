/**
 * Install / upgrade / uninstall lifecycle of the Camoufox browser, end to end through the
 * real `scripts/setup.cjs` and `scripts/cleanup.cjs` subprocesses.
 *
 * The scripts run from a throwaway "project root" (copies of the three shipped scripts)
 * whose node_modules holds a FAKE `@camoufox/camoufox` CLI that reproduces the two upstream
 * behaviours the design exists to survive:
 *   - `fetch` rm -rf's a non-empty install dir that has no `.0.5_FLAG` BEFORE downloading
 *     (so a legacy flat camoufox-js install is destroyed even when the download then fails);
 *   - `remove -y` deletes the whole install dir.
 * Every spawn uses a fully pinned env built from scratch with HOME and XDG_CACHE_HOME inside
 * the tmpdir, so nothing can reach the developer's real ~/.cache/camoufox. The install dir
 * itself is resolved through the shipped camoufox-layout.cjs for the RUNNING platform, so the
 * fixtures follow macOS (HOME/Library/Caches, a custom dir is ignored there) and Windows
 * (LOCALAPPDATA) as well as Linux.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHIPPED = ['setup.cjs', 'cleanup.cjs', 'camoufox-layout.cjs'];

const FAKE_CLI = `
const fs = require('fs'), path = require('path');
const base = process.env.XDG_CACHE_HOME;
const dir = process.env.PIR_FAKE_DIR;
if (!dir) throw new Error('fake camoufox: PIR_FAKE_DIR is not set');
const log = (m) => fs.appendFileSync(path.join(base, 'fake-cli.log'), m + '\\n');
const cmd = process.argv[2];
if (cmd === 'fetch') {
  // What the real CLI does first: wipe a non-empty dir that lacks the compat flag.
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 && !fs.existsSync(path.join(dir, '.0.5_FLAG'))) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log('fetch dir-entries=' + (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0));
  if (process.env.FAKE_FAIL === '1') { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'partial'), 'x'); process.exit(1); }
  const folder = '156.0.1-beta.34-deadbeef';
  const b = path.join(dir, 'browsers', 'official', folder);
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'version.json'), JSON.stringify({ version: '156.0.1', build: 'beta.34' }));
  fs.writeFileSync(path.join(b, 'camoufox-bin'), 'new');
  fs.writeFileSync(path.join(dir, '.0.5_FLAG'), '');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ active_version: 'browsers/official/' + folder }));
} else if (cmd === 'remove') {
  log('remove ' + process.argv.slice(3).join(' '));
  fs.rmSync(dir, { recursive: true, force: true });
}
`;

interface LayoutModule {
  resolveInstall(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): { dir: string; overrides: Record<string, string>; custom: string | null; ignoredCustom: boolean };
}

let proj: string;
let home: string;
let cache: string; // XDG_CACHE_HOME (the fake CLI's log lives here on every platform)
let dir: string;   // the install dir the shipped layout resolves for THIS platform
let layout: LayoutModule;

/** The pinned environment every spawn starts from, before per-case overrides. */
function pinnedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: cache,
    ...extra,
  };
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pir-lifecycle-'));
  proj = path.join(base, 'proj');
  home = path.join(base, 'home');
  cache = path.join(home, '.cache');
  fs.mkdirSync(path.join(proj, 'scripts'), { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  for (const f of SHIPPED) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(proj, 'scripts', f));
  // Resolve the install dir through the shipped twin, for the running platform: Linux and
  // Windows follow XDG_CACHE_HOME / LOCALAPPDATA, macOS uses HOME/Library/Caches and
  // deliberately ignores a custom dir. Fixtures and the fake CLI share this one value.
  layout = createRequire(path.join(proj, 'scripts', 'cleanup.cjs'))('./camoufox-layout.cjs') as LayoutModule;
  dir = layout.resolveInstall(pinnedEnv(), process.platform, home).dir;
  const pkg = path.join(proj, 'node_modules', '@camoufox', 'camoufox');
  fs.mkdirSync(path.join(pkg, 'dist', 'data-files'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@camoufox/camoufox', version: '0.0.0-fake', bin: { camoufox: 'dist/__main__.js' } }));
  fs.writeFileSync(path.join(pkg, 'dist', '__main__.js'), FAKE_CLI);
  fs.writeFileSync(path.join(pkg, 'dist', 'data-files', 'browser-pin.json'), JSON.stringify({ tag: 'v156.0.1-beta.34', repo: 'daijro/camoufox', repo_name: 'Official', version: '156.0.1', build: 'beta.34' }));
});
afterEach(() => { fs.rmSync(path.dirname(proj), { recursive: true, force: true }); });

function run(script: 'setup.cjs' | 'cleanup.cjs', extra: Record<string, string> = {}) {
  const env = pinnedEnv({ PIR_FAKE_DIR: dir, ...extra });
  return spawnSync(process.execPath, [path.join(proj, 'scripts', script)], { encoding: 'utf-8', env, cwd: home, timeout: 60_000 });
}

const fetchLog = () => {
  try { return fs.readFileSync(path.join(cache, 'fake-cli.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const builds = (d = dir) => {
  try { return fs.readdirSync(path.join(d, 'browsers', 'official')); } catch { return []; }
};
function plantLegacy(d = dir): void {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'version.json'), JSON.stringify({ version: '152.0.4', release: 'beta.29' }));
  fs.writeFileSync(path.join(d, 'camoufox-bin'), 'old');
  fs.writeFileSync(path.join(d, 'properties.json'), '{}');
}

describe('setup.cjs — install, migrate, upgrade', () => {
  it('fresh install fetches once and leaves exactly one usable build', () => {
    const r = run('setup.cjs');
    expect(r.status).toBe(0);
    expect(builds()).toEqual(['156.0.1-beta.34-deadbeef']);
    expect(fs.existsSync(path.join(dir, '.0.5_FLAG'))).toBe(true);
    expect(r.stdout).toContain('camoufox ready (156.0.1-beta.34-deadbeef)');
    expect(fetchLog()).toEqual(['fetch dir-entries=0']);
  });

  it('a second run is a no-op: no fetch, no download', () => {
    run('setup.cjs');
    const r = run('setup.cjs');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('already installed');
    expect(fetchLog()).toHaveLength(1);
  });

  it('migrates a legacy flat install: moved aside before the fetch, removed after, one browser left, no stash', () => {
    plantLegacy();
    const r = run('setup.cjs');
    expect(r.status).toBe(0);
    // The real CLI would have wiped the dir itself; with the stash it saw an EMPTY dir.
    expect(fetchLog()).toEqual(['fetch dir-entries=0']);
    expect(builds()).toEqual(['156.0.1-beta.34-deadbeef']);
    expect(fs.existsSync(path.join(dir, 'camoufox-bin'))).toBe(false);
    expect(fs.readdirSync(path.dirname(dir)).filter((e) => e.startsWith(path.basename(dir)))).toEqual([path.basename(dir)]);
    expect(r.stdout).toContain('removed the legacy Camoufox install');
  });

  it('a FAILED fetch restores the legacy browser (exit 0 normally, exit 1 under PI_RESEARCH_STRICT_SETUP)', () => {
    plantLegacy();
    const soft = run('setup.cjs', { FAKE_FAIL: '1' });
    expect(soft.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'camoufox-bin'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(dir, 'partial'))).toBe(false);
    expect(fs.readdirSync(path.dirname(dir)).filter((e) => e.startsWith(path.basename(dir)))).toEqual([path.basename(dir)]);
    expect(soft.stderr).toContain('Camoufox browser install failed');

    const strict = run('setup.cjs', { FAKE_FAIL: '1', PI_RESEARCH_STRICT_SETUP: '1' });
    expect(strict.status).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'camoufox-bin'), 'utf8')).toBe('old');
  });

  it('upgrade: a superseded build is pruned once the newly paired one is installed', () => {
    const old = path.join(dir, 'browsers', 'official', '150.0.2-beta.25-oldoldol');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'version.json'), JSON.stringify({ version: '150.0.2', build: 'beta.25' }));
    fs.writeFileSync(path.join(dir, '.0.5_FLAG'), '');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ active_version: 'browsers/official/150.0.2-beta.25-oldoldol' }));
    const r = run('setup.cjs');
    expect(r.status).toBe(0);
    expect(builds()).toEqual(['156.0.1-beta.34-deadbeef']);
    expect(r.stdout).toContain('removed superseded Camoufox build');
  });

  it('a failed upgrade keeps the old (still launchable) build', () => {
    const old = path.join(dir, 'browsers', 'official', '150.0.2-beta.25-oldoldol');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'version.json'), JSON.stringify({ version: '150.0.2', build: 'beta.25' }));
    fs.writeFileSync(path.join(dir, '.0.5_FLAG'), '');
    run('setup.cjs', { FAKE_FAIL: '1' });
    expect(builds()).toEqual(['150.0.2-beta.25-oldoldol']);
  });

  // macOS deliberately ignores a custom dir (the launcher derives the cache from HOME and
  // cannot be relocated). That behaviour is asserted in camoufox-layout.test.ts, so the
  // honored-custom path here is Linux/Windows only.
  it.skipIf(process.platform === 'darwin')('a custom CAMOUFOX_INSTALL_DIR is translated into the cache root the launcher reads', () => {
    const custom = path.join(home, 'elsewhere');
    fs.mkdirSync(custom, { recursive: true });
    const expected = layout.resolveInstall(pinnedEnv({ CAMOUFOX_INSTALL_DIR: custom }), process.platform, home).dir;
    const r = run('setup.cjs', { CAMOUFOX_INSTALL_DIR: custom, PIR_FAKE_DIR: expected });
    expect(r.status).toBe(0);
    expect(builds(expected)).toEqual(['156.0.1-beta.34-deadbeef']);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 installs nothing', () => {
    const r = run('setup.cjs', { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fetchLog()).toEqual([]);
  });
});

describe('cleanup.cjs — uninstall', () => {
  it('leaves the shared browser cache alone by default', () => {
    run('setup.cjs');
    const r = run('cleanup.cjs');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('leaving shared camoufox binaries in place');
    expect(builds()).toEqual(['156.0.1-beta.34-deadbeef']);
  });

  it('PI_RESEARCH_PURGE_BROWSERS=1 removes everything: the CLI path, then no data dir left', () => {
    run('setup.cjs');
    const r = run('cleanup.cjs', { PI_RESEARCH_PURGE_BROWSERS: '1' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fetchLog()).toContain('remove -y');
  });

  it('purge also clears a legacy flat install and a stash a crashed upgrade left behind', () => {
    plantLegacy();
    plantLegacy(`${dir}.legacy-9-9`);
    const r = run('cleanup.cjs', { PI_RESEARCH_PURGE_BROWSERS: '1' });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(path.dirname(dir)).filter((e) => e.startsWith(path.basename(dir)))).toEqual([]);
  });

  it('purge is idempotent', () => {
    run('setup.cjs');
    run('cleanup.cjs', { PI_RESEARCH_PURGE_BROWSERS: '1' });
    const again = run('cleanup.cjs', { PI_RESEARCH_PURGE_BROWSERS: '1' });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('no Camoufox browser data to remove');
  });

  it('purge still works after the package is gone (CLI missing): direct, guarded removal', () => {
    run('setup.cjs');
    fs.rmSync(path.join(proj, 'node_modules'), { recursive: true, force: true });
    const r = run('cleanup.cjs', { PI_RESEARCH_PURGE_BROWSERS: '1' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('REFUSES to delete a directory that is not provably a Camoufox install', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'precious.txt'), 'user data');
    const r = run('cleanup.cjs', { PI_RESEARCH_PURGE_BROWSERS: '1' });
    expect(r.status).toBe(0);
    expect(r.stderr + r.stdout).toContain('refusing to delete');
    expect(fs.readFileSync(path.join(dir, 'precious.txt'), 'utf8')).toBe('user data');
  });
});

describe('packaging', () => {
  it('every script setup.cjs/cleanup.cjs requires locally is listed in package.json files[]', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { files: string[] };
    for (const f of ['setup.cjs', 'cleanup.cjs']) {
      const src = fs.readFileSync(path.join(REPO, 'scripts', f), 'utf8');
      for (const m of src.matchAll(/require\('\.\/([^']+)'\)/g)) {
        expect(pkg.files, `${f} requires ./${m[1]}`).toContain(`scripts/${m[1]}`);
      }
    }
  });
});
