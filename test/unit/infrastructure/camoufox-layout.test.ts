/**
 * Camoufox install-layout helpers, in both their forms.
 *
 * `src/infrastructure/browser/camoufox-layout.ts` (runtime) and
 * `scripts/camoufox-layout.cjs` (install/uninstall) are deliberate twins: a drift
 * between "where setup installed the browser" and "where the runtime looks" is exactly
 * the install/runtime mismatch this package has shipped before. Every case below runs
 * against BOTH implementations on the same fixtures and must give identical answers.
 *
 * Fixtures are real directories under a throwaway tmpdir; nothing here can reach the
 * developer's real browser cache.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from '../../../src/infrastructure/browser/camoufox-layout.ts';

const cjs = createRequire(import.meta.url)('../../../scripts/camoufox-layout.cjs') as Record<string, (...a: unknown[]) => unknown>;

const PIN = { repoName: 'official', version: '156.0.1', build: 'beta.34' };
let root: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pir-layout-'));
  dir = path.join(root, 'camoufox');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function build(folder: string, version: string, buildTag: string, opts: { active?: boolean; flag?: boolean } = {}): string {
  const b = path.join(dir, 'browsers', 'official', folder);
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'version.json'), JSON.stringify({ version, build: buildTag }));
  fs.writeFileSync(path.join(b, 'camoufox-bin'), 'x');
  if (opts.flag !== false) fs.writeFileSync(path.join(dir, '.0.5_FLAG'), '');
  if (opts.active !== false) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ active_version: `browsers/official/${folder}` }));
  return b;
}

function legacy(d = dir): void {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'version.json'), JSON.stringify({ version: '135.0.1', release: 'beta.24' }));
  fs.writeFileSync(path.join(d, 'camoufox-bin'), 'old');
}

/** Run `fn` against both implementations on a fresh copy of the same fixture. */
function both<T>(setup: () => void, fn: (impl: 'ts' | 'cjs') => T): { ts: T; cjs: T } {
  fs.rmSync(dir, { recursive: true, force: true });
  setup();
  const a = fn('ts');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const e of fs.readdirSync(root)) if (e !== 'camoufox') fs.rmSync(path.join(root, e), { recursive: true, force: true });
  setup();
  const b = fn('cjs');
  return { ts: a, cjs: b };
}

describe('resolveInstall — placement of the cache', () => {
  const cases: Array<[string, NodeJS.Platform, NodeJS.ProcessEnv]> = [
    ['linux default', 'linux', {}],
    ['linux XDG_CACHE_HOME', 'linux', { XDG_CACHE_HOME: '/xdg' }],
    ['linux blank XDG_CACHE_HOME falls back to ~/.cache', 'linux', { XDG_CACHE_HOME: '  ' }],
    ['linux custom dir', 'linux', { CAMOUFOX_INSTALL_DIR: '/opt/cfx' }],
    ['linux custom dir ending in camoufox', 'linux', { PLAYWRIGHT_BROWSERS_PATH: '/opt/camoufox' }],
    ['linux CAMOUFOX_INSTALL_DIR beats PLAYWRIGHT_BROWSERS_PATH', 'linux', { CAMOUFOX_INSTALL_DIR: '/a', PLAYWRIGHT_BROWSERS_PATH: '/b' }],
    ['darwin ignores a custom dir', 'darwin', { CAMOUFOX_INSTALL_DIR: '/opt/cfx' }],
    ['win32 default', 'win32', {}],
    ['win32 LOCALAPPDATA', 'win32', { LOCALAPPDATA: 'D:\\L' }],
    ['win32 relative LOCALAPPDATA is ignored', 'win32', { LOCALAPPDATA: 'rel' }],
    ['win32 custom dir', 'win32', { CAMOUFOX_INSTALL_DIR: 'E:\\cfx' }],
  ];
  it.each(cases)('twins agree: %s', (_n, platform, env) => {
    const a = ts.resolveInstall(env, platform, '/home/u');
    const b = cjs['resolveInstall']!(env, platform, '/home/u');
    expect(b).toEqual(a);
  });

  it('flags the macOS case so callers can say the setting is ignored', () => {
    const r = ts.resolveInstall({ CAMOUFOX_INSTALL_DIR: '/opt/cfx' }, 'darwin', '/home/u');
    expect(r.ignoredCustom).toBe(true);
    expect(r.overrides).toEqual({});
    expect(r.dir).toBe(path.join('/home/u', 'Library', 'Caches', 'camoufox'));
  });

  it('translates a custom dir into the variable the launcher actually reads', () => {
    // Custom dirs are resolved with the HOST path flavor (the explicit platform argument
    // exists so the branches can be pushed from any host; production passes process.platform),
    // hence resolve() rather than a POSIX literal, which keeps this portable to Windows.
    expect(ts.resolveInstall({ CAMOUFOX_INSTALL_DIR: '/opt/cfx' }, 'linux', '/h').overrides).toEqual({ XDG_CACHE_HOME: path.resolve('/opt/cfx') });
    expect(ts.resolveInstall({ CAMOUFOX_INSTALL_DIR: 'E:\\cfx' }, 'win32', 'C:\\h').overrides).toEqual({ LOCALAPPDATA: 'E:\\cfx' });
  });
});

describe('new-layout detection', () => {
  it('lists builds that have a parseable version.json and ignores the rest', () => {
    const r = both(() => {
      build('156.0.1-beta.34-aaaa', '156.0.1', 'beta.34');
      fs.mkdirSync(path.join(dir, 'browsers', 'official', 'broken'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'browsers', 'official', 'broken', 'version.json'), '{nope');
      fs.mkdirSync(path.join(dir, 'browsers', 'official', 'empty'), { recursive: true });
    }, (impl) => (impl === 'ts' ? ts.listInstalls(dir) : (cjs['listInstalls']!(dir) as ReturnType<typeof ts.listInstalls>)).map((b) => b.rel));
    expect(r.ts).toEqual(['browsers/official/156.0.1-beta.34-aaaa']);
    expect(r.cjs).toEqual(r.ts);
  });

  it('usable = compat flag + paired build; a bare non-empty dir or a stale build is not', () => {
    const usable = (impl: 'ts' | 'cjs') => (impl === 'ts' ? ts.isUsable(dir, PIN) : cjs['isUsable']!(dir, PIN));
    expect(both(() => legacy(), usable)).toEqual({ ts: false, cjs: false });
    expect(both(() => build('150.0.2-beta.25-bb', '150.0.2', 'beta.25'), usable)).toEqual({ ts: false, cjs: false });
    expect(both(() => build('156.0.1-beta.34-aa', '156.0.1', 'beta.34'), usable)).toEqual({ ts: true, cjs: true });
    expect(both(() => build('156.0.1-beta.34-aa', '156.0.1', 'beta.34', { flag: false }), usable)).toEqual({ ts: false, cjs: false });
  });

  it('with no pin any build counts; an explicit user choice (camoufox set) also accepts any build', () => {
    const usable = (impl: 'ts' | 'cjs') => (impl === 'ts' ? ts.isUsable(dir, PIN) : cjs['isUsable']!(dir, PIN));
    expect(both(() => build('150.0.2-beta.25-bb', '150.0.2', 'beta.25'), (i) => (i === 'ts' ? ts.isUsable(dir, null) : cjs['isUsable']!(dir, null)))).toEqual({ ts: true, cjs: true });
    expect(both(() => {
      build('150.0.2-beta.25-bb', '150.0.2', 'beta.25');
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ pinned: '150.0.2-beta.25', active_version: 'browsers/official/150.0.2-beta.25-bb' }));
    }, usable)).toEqual({ ts: true, cjs: true });
  });
});

describe('legacy flat detection', () => {
  const isLegacy = (impl: 'ts' | 'cjs') => (impl === 'ts' ? ts.isLegacyFlat(dir) : cjs['isLegacyFlat']!(dir));
  it('claims only a provable camoufox-js install', () => {
    expect(both(() => legacy(), isLegacy)).toEqual({ ts: true, cjs: true });
    // version.json alone, without a camoufox file: not claimed
    expect(both(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1', release: '2' })); }, isLegacy)).toEqual({ ts: false, cjs: false });
    // camoufox-looking file without a version.json: not claimed
    expect(both(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'camoufox-bin'), 'x'); }, isLegacy)).toEqual({ ts: false, cjs: false });
    // a new-layout dir is never legacy
    expect(both(() => { legacy(); fs.writeFileSync(path.join(dir, '.0.5_FLAG'), ''); }, isLegacy)).toEqual({ ts: false, cjs: false });
    // an unrelated directory
    expect(both(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine'); }, isLegacy)).toEqual({ ts: false, cjs: false });
  });
});

describe('pruneSuperseded', () => {
  const list = () => fs.readdirSync(path.join(dir, 'browsers', 'official')).sort();
  const prune = (impl: 'ts' | 'cjs', pin: typeof PIN | null) => (impl === 'ts' ? ts.pruneSuperseded(dir, () => {}, pin) : (cjs['pruneSuperseded']!(dir, () => {}, pin) as string[]));

  it('keeps only the paired build and removes the rest', () => {
    const r = both(() => {
      build('150.0.2-beta.25-bb', '150.0.2', 'beta.25', { active: false });
      build('152.0.4-beta.30-cc', '152.0.4', 'beta.30', { active: false });
      build('156.0.1-beta.34-aa', '156.0.1', 'beta.34');
    }, (i) => ({ removed: prune(i, PIN).sort(), left: list() }));
    expect(r.ts).toEqual({ removed: ['browsers/official/150.0.2-beta.25-bb', 'browsers/official/152.0.4-beta.30-cc'], left: ['156.0.1-beta.34-aa'] });
    expect(r.cjs).toEqual(r.ts);
  });

  it('never removes anything when the paired build is not installed (would leave no browser)', () => {
    const r = both(() => build('150.0.2-beta.25-bb', '150.0.2', 'beta.25'), (i) => ({ removed: prune(i, PIN), left: list() }));
    expect(r.ts).toEqual({ removed: [], left: ['150.0.2-beta.25-bb'] });
    expect(r.cjs).toEqual(r.ts);
  });

  it('keeps the active build when there is no pin, and does nothing without an identifiable one', () => {
    const r = both(() => {
      build('150.0.2-beta.25-bb', '150.0.2', 'beta.25', { active: false });
      build('152.0.4-beta.30-cc', '152.0.4', 'beta.30');
    }, (i) => ({ removed: prune(i, null), left: list() }));
    expect(r.ts).toEqual({ removed: ['browsers/official/150.0.2-beta.25-bb'], left: ['152.0.4-beta.30-cc'] });
    const none = both(() => { build('150.0.2-beta.25-bb', '150.0.2', 'beta.25', { active: false }); }, (i) => ({ removed: prune(i, null), left: list() }));
    expect(none.ts.removed).toEqual([]);
    expect(none.cjs).toEqual(none.ts);
  });

  it('respects an explicit user choice (camoufox set): their versions are theirs', () => {
    const r = both(() => {
      build('150.0.2-beta.25-bb', '150.0.2', 'beta.25', { active: false });
      build('156.0.1-beta.34-aa', '156.0.1', 'beta.34');
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channel: 'official/stable', active_version: 'browsers/official/156.0.1-beta.34-aa' }));
    }, (i) => ({ removed: prune(i, PIN), left: list() }));
    expect(r.ts.removed).toEqual([]);
    expect(r.ts.left).toHaveLength(2);
    expect(r.cjs).toEqual(r.ts);
  });
});

describe('provisionBrowser — never leaves the user with less than they had', () => {
  const fixture = (folder = '156.0.1-beta.34-aa') => () => { build(folder, '156.0.1', 'beta.34'); };

  async function provision(impl: 'ts' | 'cjs', fetch: () => boolean) {
    const msgs: string[] = [];
    const res = impl === 'ts'
      ? await ts.provisionBrowser(dir, async () => fetch(), (m) => msgs.push(m), PIN)
      : (cjs['provisionBrowser']!(dir, fetch, (m: string) => msgs.push(m), PIN) as ReturnType<typeof Object>);
    return { res: res as { status: string; pruned: string[]; reason?: string }, msgs };
  }

  it('present: no fetch when the paired build is installed (idempotent second run)', async () => {
    for (const impl of ['ts', 'cjs'] as const) {
      fs.rmSync(dir, { recursive: true, force: true });
      fixture()();
      let fetched = 0;
      const a = await provision(impl, () => { fetched++; return true; });
      const b = await provision(impl, () => { fetched++; return true; });
      expect([a.res.status, b.res.status, fetched]).toEqual(['present', 'present', 0]);
    }
  });

  it('legacy install: dir is clear during the fetch, stash removed after success, exactly one browser remains', async () => {
    for (const impl of ['ts', 'cjs'] as const) {
      fs.rmSync(dir, { recursive: true, force: true });
      legacy();
      let seen: string[] | null = null;
      const r = await provision(impl, () => {
        seen = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        fixture()();
        return true;
      });
      expect(r.res.status).toBe('installed');
      expect(seen).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'camoufox-bin'))).toBe(false);
      expect(fs.readdirSync(root)).toEqual(['camoufox']);
      expect(ts.listInstalls(dir)).toHaveLength(1);
    }
  });

  it('failed fetch (non-zero, throw, or exit 0 without a build) restores the legacy install untouched', async () => {
    const failures: Array<() => boolean> = [
      () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'partial'), 'x'); return false; },
      () => { throw new Error('network down'); },
      () => true,
    ];
    for (const impl of ['ts', 'cjs'] as const) {
      for (const f of failures) {
        fs.rmSync(dir, { recursive: true, force: true });
        legacy();
        const r = await provision(impl, f);
        expect(r.res.status).toBe('failed');
        expect(fs.readFileSync(path.join(dir, 'camoufox-bin'), 'utf8')).toBe('old');
        expect(fs.existsSync(path.join(dir, 'partial'))).toBe(false);
        expect(fs.readdirSync(root)).toEqual(['camoufox']);
      }
    }
  });

  it('a fetch that fails AFTER installing the paired build keeps it (companion download failed)', async () => {
    for (const impl of ['ts', 'cjs'] as const) {
      fs.rmSync(dir, { recursive: true, force: true });
      legacy();
      // The launcher extracts the browser (and writes .0.5_FLAG) before it fetches its
      // companion geoip database from a separate release; a failure there exits non-zero
      // over a launchable build. Keep it instead of restoring the legacy one.
      const r = await provision(impl, () => { fixture()(); return false; });
      expect(r.res.status).toBe('installed');
      expect(fs.existsSync(path.join(dir, 'camoufox-bin'))).toBe(false); // legacy discarded, not restored
      expect(fs.readdirSync(root)).toEqual(['camoufox']);                // no stash left behind
      expect(ts.listInstalls(dir)).toHaveLength(1);
      expect(r.msgs.join('\n')).toContain('keeping it');
    }
  });

  it('recovers a stash left by a crashed upgrade (dir missing) before doing anything else', async () => {
    for (const impl of ['ts', 'cjs'] as const) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      legacy(`${dir}.legacy-123-456`);
      const r = await provision(impl, () => false);
      // The fetch failed, so the recovered legacy install is what the user keeps.
      expect(r.res.status).toBe('failed');
      expect(fs.readFileSync(path.join(dir, 'camoufox-bin'), 'utf8')).toBe('old');
      expect(fs.readdirSync(root)).toEqual(['camoufox']);
    }
  });

  it('sweeps a stale stash once the new layout is usable', async () => {
    for (const impl of ['ts', 'cjs'] as const) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      fixture()();
      legacy(`${dir}.legacy-1-2`);
      const r = await provision(impl, () => true);
      expect(r.res.status).toBe('present');
      expect(fs.readdirSync(root)).toEqual(['camoufox']);
    }
  });

  it('upgrade to a new pin prunes the superseded build only after the new one is verified', async () => {
    for (const impl of ['ts', 'cjs'] as const) {
      fs.rmSync(dir, { recursive: true, force: true });
      build('150.0.2-beta.25-bb', '150.0.2', 'beta.25');
      const ok = await provision(impl, () => { fixture()(); return true; });
      expect(ok.res.status).toBe('installed');
      expect(ok.res.pruned).toEqual(['browsers/official/150.0.2-beta.25-bb']);

      fs.rmSync(dir, { recursive: true, force: true });
      build('150.0.2-beta.25-bb', '150.0.2', 'beta.25');
      const bad = await provision(impl, () => false);
      expect(bad.res.status).toBe('failed');
      expect(fs.readdirSync(path.join(dir, 'browsers', 'official'))).toEqual(['150.0.2-beta.25-bb']);
    }
  });
});

describe('removeInstallDir — ownership guard', () => {
  it('removes a provable Camoufox dir (new or legacy) and refuses anything else', () => {
    const remove = (impl: 'ts' | 'cjs') => (impl === 'ts' ? ts.removeInstallDir(dir) : cjs['removeInstallDir']!(dir));
    expect(both(() => build('156.0.1-beta.34-aa', '156.0.1', 'beta.34'), remove)).toEqual({ ts: 'removed', cjs: 'removed' });
    expect(both(() => legacy(), remove)).toEqual({ ts: 'removed', cjs: 'removed' });
    expect(both(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'docs.txt'), 'not camoufox'); }, remove)).toEqual({ ts: 'refused', cjs: 'refused' });
    expect(fs.existsSync(path.join(dir, 'docs.txt'))).toBe(true);
    expect(both(() => {}, remove)).toEqual({ ts: 'absent', cjs: 'absent' });
  });
});

describe('browser-pin.json', () => {
  it('both twins read the pin the installed launcher ships', () => {
    const pkg = ts.findPackageRoot(import.meta.url);
    expect(pkg).toBeTruthy();
    const a = ts.loadPin(pkg!);
    const b = cjs['loadPin']!(pkg) as typeof a;
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(a!.repoName).toBe('official');
  });
});
