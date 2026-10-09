/**
 * Tests for runtime browser provisioning (ensureBrowserInstalled).
 *
 * Runs against a REAL throwaway cache directory (the layout module is plain fs) with
 * only the child process mocked, so the install/upgrade/rollback behaviour is exercised
 * end to end rather than against fs call sequences.
 *
 * The regression-critical guarantees:
 *  - When the paired browser build is already present it is a no-op and NEVER spawns a fetch.
 *  - When PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 (CI / unit tests), it never fetches.
 *  - Only when the paired build is genuinely absent AND not skipped does it fetch.
 *  - A legacy flat camoufox-js install is moved aside before the fetch and removed only
 *    once the new build verifies; a failed fetch puts it back.
 *  - After an upgrade the superseded build is pruned so two browsers never accumulate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../src/infrastructure/browser/config.ts', () => ({
  getCamoufoxBinaryPath: vi.fn(() => state.dir),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

// The pin this repo's installed launcher was released with.
const pkgRoot = path.dirname(createRequire(import.meta.url).resolve('@camoufox/camoufox/package.json'));
const PIN = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'dist', 'data-files', 'browser-pin.json'), 'utf8')) as {
  version: string; build: string; repo_name: string;
};

/** Create `browsers/<repo>/<folder>/version.json` (+ optionally the compat flag and active_version). */
function writeBuild(dir: string, folder: string, version: string, build: string, active = true): string {
  const repo = PIN.repo_name.toLowerCase();
  const bdir = path.join(dir, 'browsers', repo, folder);
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'version.json'), JSON.stringify({ version, build }));
  fs.writeFileSync(path.join(bdir, 'camoufox-bin'), 'bin');
  fs.writeFileSync(path.join(dir, '.0.5_FLAG'), '');
  if (active) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ active_version: `browsers/${repo}/${folder}` }));
  return bdir;
}

function writeLegacy(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '135.0.1', release: 'beta.24' }));
  fs.writeFileSync(path.join(dir, 'camoufox-bin'), 'old');
  fs.writeFileSync(path.join(dir, 'properties.json'), '{}');
}

/** spawn() stand-in: runs `onFetch` (the "download"), then exits with `code`. */
function spawnWith(onFetch: () => void, code = 0): void {
  spawnMock.mockImplementation(() => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    queueMicrotask(() => {
      try { onFetch(); } catch { /* the test asserts on the outcome */ }
      handlers['exit']?.(code);
    });
    // The fetch child's stdout is piped to a temp log file in the real module.
    return { on: (ev: string, cb: (arg?: unknown) => void) => { handlers[ev] = cb; }, kill: vi.fn(), stdout: { pipe: vi.fn() } };
  });
}

async function freshModule() {
  vi.resetModules();
  return await import('../../../src/infrastructure/browser/ensure-browser.ts');
}

describe('ensureBrowserInstalled', () => {
  const savedSkip = process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];
  let root: string;

  beforeEach(() => {
    spawnMock.mockReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ensure-browser-'));
    state.dir = path.join(root, 'camoufox');
    delete process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];
  });

  afterEach(() => {
    if (savedSkip === undefined) delete process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];
    else process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = savedSkip;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op (no fetch) when the paired browser build is already installed', async () => {
    writeBuild(state.dir, `${PIN.version}-${PIN.build}-aaaaaaaa`, PIN.version, PIN.build);
    const { ensureBrowserInstalled } = await freshModule();
    await ensureBrowserInstalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('never fetches when PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, even if absent', async () => {
    process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = '1';
    const { ensureBrowserInstalled } = await freshModule();
    await ensureBrowserInstalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fetches exactly once through the camoufox CLI (argv array, no shell) when the build is absent', async () => {
    spawnWith(() => { writeBuild(state.dir, `${PIN.version}-${PIN.build}-aaaaaaaa`, PIN.version, PIN.build); });
    const { ensureBrowserInstalled, isBrowserBinaryPresent } = await freshModule();
    await ensureBrowserInstalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { shell?: boolean; stdio?: unknown }];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toMatch(/camoufox[\\/]dist[\\/]__main__\.js$/);
    expect(args[1]).toBe('fetch');
    expect(opts.shell).toBeUndefined();
    // stdout is captured (not inherited): an inherited fd 1 would write raw to the
    // terminal and, inside a pi session, corrupt the host's output stream.
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'inherit']);
    expect(isBrowserBinaryPresent()).toBe(true);
  });

  it('dedupes concurrent callers into a single fetch', async () => {
    spawnWith(() => { writeBuild(state.dir, `${PIN.version}-${PIN.build}-aaaaaaaa`, PIN.version, PIN.build); });
    const { ensureBrowserInstalled } = await freshModule();
    await Promise.all([ensureBrowserInstalled(), ensureBrowserInstalled(), ensureBrowserInstalled()]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('a bare non-empty directory (legacy flat install) is NOT "present"', async () => {
    writeLegacy(state.dir);
    const { isBrowserBinaryPresent } = await freshModule();
    expect(isBrowserBinaryPresent()).toBe(false);
  });

  it('migrates a legacy flat install: stashed during the fetch, deleted only after the new build verifies', async () => {
    writeLegacy(state.dir);
    let legacyDuringFetch: string[] = [];
    spawnWith(() => {
      // The real `camoufox fetch` rm -rf's a non-empty dir without the flag. By the time it runs
      // our dir must already be clear (the legacy tree moved aside), so nothing is lost if it fails.
      legacyDuringFetch = fs.existsSync(state.dir) ? fs.readdirSync(state.dir) : [];
      writeBuild(state.dir, `${PIN.version}-${PIN.build}-aaaaaaaa`, PIN.version, PIN.build);
    });
    const { ensureBrowserInstalled, isBrowserBinaryPresent } = await freshModule();
    await ensureBrowserInstalled();
    expect(legacyDuringFetch).toEqual([]);
    expect(isBrowserBinaryPresent()).toBe(true);
    // Exactly one browser remains: no flat files, no leftover stash beside the cache dir.
    expect(fs.existsSync(path.join(state.dir, 'camoufox-bin'))).toBe(false);
    expect(fs.readdirSync(root)).toEqual(['camoufox']);
  });

  it('restores the legacy install when the fetch fails (exit code 1)', async () => {
    writeLegacy(state.dir);
    spawnWith(() => { fs.mkdirSync(state.dir, { recursive: true }); fs.writeFileSync(path.join(state.dir, 'partial'), 'x'); }, 1);
    const { ensureBrowserInstalled } = await freshModule();
    await ensureBrowserInstalled();
    expect(fs.readFileSync(path.join(state.dir, 'camoufox-bin'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(state.dir, 'partial'))).toBe(false);
    expect(fs.readdirSync(root)).toEqual(['camoufox']);
  });

  it('restores the legacy install when the fetch exits 0 but installs nothing usable', async () => {
    writeLegacy(state.dir);
    spawnWith(() => { /* "succeeds" without producing a build */ }, 0);
    const { ensureBrowserInstalled } = await freshModule();
    await ensureBrowserInstalled();
    expect(fs.readFileSync(path.join(state.dir, 'camoufox-bin'), 'utf8')).toBe('old');
  });

  it('upgrade: fetches the newly paired build and prunes the superseded one', async () => {
    const oldBuild = writeBuild(state.dir, '150.0.2-beta.25-bbbbbbbb', '150.0.2', 'beta.25');
    spawnWith(() => { writeBuild(state.dir, `${PIN.version}-${PIN.build}-aaaaaaaa`, PIN.version, PIN.build); });
    const { ensureBrowserInstalled } = await freshModule();
    await ensureBrowserInstalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(oldBuild)).toBe(false);
    const left = fs.readdirSync(path.join(state.dir, 'browsers', PIN.repo_name.toLowerCase()));
    expect(left).toEqual([`${PIN.version}-${PIN.build}-aaaaaaaa`]);
  });
});
