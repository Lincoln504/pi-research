import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

// Deterministically control os.platform() so every platform branch of the
// path-resolution logic is exercised on any host. CI runs on Linux, so without
// this the darwin/win32 branches would never execute (the previous tests
// early-returned on non-matching platforms and asserted nothing).
const osMock = vi.hoisted(() => ({ current: 'linux' as NodeJS.Platform }));
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, platform: () => osMock.current };
});

import { getBrowserCacheDir, getBrowserEnv, getBrowserProfileDir, getCamoufoxBinaryPath, resolveHeadlessMode } from '../../../src/infrastructure/browser/config.ts';

describe('browser-config', () => {
    const ENV_KEYS = ['PLAYWRIGHT_BROWSERS_PATH', 'CAMOUFOX_INSTALL_DIR', 'XDG_CACHE_HOME', 'LOCALAPPDATA'] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        osMock.current = 'linux';
        for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
        delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
        // Must be cleared too: it now participates in path resolution, so an
        // ambient value would silently steer every assertion below.
        delete process.env['CAMOUFOX_INSTALL_DIR'];
        delete process.env['XDG_CACHE_HOME'];
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    describe('getBrowserCacheDir', () => {
        it('PLAYWRIGHT_BROWSERS_PATH relocates the Linux cache HOME (the launcher reads XDG_CACHE_HOME)', () => {
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/my/browser/path';
            // A custom dir is resolved with the HOST path flavor: the layout module takes an
            // explicit platform only so its branches can be pushed from any host, while the
            // custom-dir resolution it mirrors is inherently host-bound (production always
            // passes process.platform). resolve() keeps this assertion portable to Windows.
            expect(getBrowserCacheDir()).toBe(join(resolve('/my/browser/path'), 'camoufox'));
        });

        it('a custom dir that already ends in "camoufox" is used as the install dir itself', () => {
            process.env['CAMOUFOX_INSTALL_DIR'] = '/opt/camoufox';
            expect(getBrowserCacheDir()).toBe(resolve('/opt/camoufox'));
        });

        it('macOS: a custom dir is ignored (the launcher derives the cache from HOME only)', () => {
            osMock.current = 'darwin';
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/my/browser/path';
            expect(getBrowserCacheDir()).toBe(join(homedir(), 'Library', 'Caches', 'camoufox'));
        });

        it('Linux: defaults to ~/.cache/camoufox', () => {
            osMock.current = 'linux';
            expect(getBrowserCacheDir()).toBe(join(homedir(), '.cache', 'camoufox'));
        });

        it('Linux: honors XDG_CACHE_HOME', () => {
            osMock.current = 'linux';
            process.env['XDG_CACHE_HOME'] = '/custom/cache';
            expect(getBrowserCacheDir()).toBe(join('/custom/cache', 'camoufox'));
        });

        it('macOS: uses ~/Library/Caches/camoufox', () => {
            osMock.current = 'darwin';
            expect(getBrowserCacheDir()).toBe(join(homedir(), 'Library', 'Caches', 'camoufox'));
        });

        it('Windows: mirrors @camoufox/camoufox userCacheDir (doubled camoufox segment, homedir fallback)', () => {
            osMock.current = 'win32';
            delete process.env['LOCALAPPDATA'];
            expect(getBrowserCacheDir()).toBe(
                join(homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
            );
        });

        it('Windows: honours an absolute LOCALAPPDATA (the new launcher reads it; camoufox-js did not)', () => {
            osMock.current = 'win32';
            process.env['LOCALAPPDATA'] = join('D:', 'Other', 'AppData', 'Local');
            expect(getBrowserCacheDir()).toBe(
                join('D:', 'Other', 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
            );
        });
    });

    describe('getBrowserEnv', () => {
        it('omits PLAYWRIGHT_BROWSERS_PATH when not set', () => {
            const env = getBrowserEnv();
            expect(env['PLAYWRIGHT_BROWSERS_PATH']).toBeUndefined();
        });

        it('translates a custom PLAYWRIGHT_BROWSERS_PATH into the XDG_CACHE_HOME the launcher reads', () => {
            // @camoufox/camoufox ignores PLAYWRIGHT_BROWSERS_PATH and CAMOUFOX_INSTALL_DIR
            // and derives its install dir from the platform cache root only. The worker
            // must be told in THAT variable or install and launch resolve to different
            // directories; the two user-facing variables are removed so nothing nested
            // reinterprets them.
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/custom/browser-cache';
            const env = getBrowserEnv();
            expect(env['XDG_CACHE_HOME']).toBe(resolve('/custom/browser-cache'));
            expect(env['PLAYWRIGHT_BROWSERS_PATH']).toBeUndefined();
            expect(env['CAMOUFOX_INSTALL_DIR']).toBeUndefined();
            expect(getBrowserCacheDir()).toBe(join(resolve('/custom/browser-cache'), 'camoufox'));
        });

        it('CAMOUFOX_INSTALL_DIR alone drives the override and the resolved paths', () => {
            process.env['CAMOUFOX_INSTALL_DIR'] = '/opt/cfx';
            const env = getBrowserEnv();
            expect(env['XDG_CACHE_HOME']).toBe(resolve('/opt/cfx'));
            expect(getBrowserCacheDir()).toBe(join(resolve('/opt/cfx'), 'camoufox'));
            expect(getCamoufoxBinaryPath()).toBe(join(resolve('/opt/cfx'), 'camoufox'));
        });

        it('Windows: a custom dir becomes LOCALAPPDATA for the worker', () => {
            osMock.current = 'win32';
            process.env['CAMOUFOX_INSTALL_DIR'] = join('D:', 'cfx');
            const env = getBrowserEnv();
            expect(env['LOCALAPPDATA']).toBe('D:\\cfx');
        });

        it('adds no placement override when no custom location is set', () => {
            const env = getBrowserEnv();
            expect(env['XDG_CACHE_HOME']).toBe(process.env['XDG_CACHE_HOME']);
            expect(env['CAMOUFOX_INSTALL_DIR']).toBeUndefined();
        });

        it('preserves HOME and USERPROFILE unchanged', () => {
            const env = getBrowserEnv();
            expect(env['HOME']).toBe(process.env['HOME']);
            expect(env['USERPROFILE']).toBe(process.env['USERPROFILE']);
        });

        it('redirects worker TMPDIR/TMP/TEMP to the dedicated browser profile dir (off a tmpfs /tmp)', () => {
            const env = getBrowserEnv();
            const profileDir = getBrowserProfileDir();
            expect(env['TMPDIR']).toBe(profileDir);
            expect(env['TMP']).toBe(profileDir);
            expect(env['TEMP']).toBe(profileDir);
        });

        it('respects a user-set PI_RESEARCH_LOG_FILE instead of clobbering it with the main log path', () => {
            const saved = process.env['PI_RESEARCH_LOG_FILE'];
            process.env['PI_RESEARCH_LOG_FILE'] = '/custom/worker.log';
            try {
                expect(getBrowserEnv()['PI_RESEARCH_LOG_FILE']).toBe('/custom/worker.log');
            } finally {
                if (saved === undefined) delete process.env['PI_RESEARCH_LOG_FILE'];
                else process.env['PI_RESEARCH_LOG_FILE'] = saved;
            }
        });
    });

    describe('getBrowserProfileDir', () => {
        it('defaults to a dedicated <cacheHome>/pi-research/profiles path (not the system temp dir)', () => {
            expect(getBrowserProfileDir()).toContain(join('pi-research', 'profiles'));
        });

        it('contains config.TMP_DIR (PI_RESEARCH_TMP_DIR) profiles in a pi-research-owned subdirectory, never the dir itself', () => {
            // Containment invariant: the pool-startup sweep treats every entry of
            // the profile dir as a reclaim candidate, so TMP_DIR verbatim (e.g.
            // /tmp per the tmpfs opt-in) would expose unrelated same-user dirs.
            // Under the OS tmpdir, NOT the real ~/.cache/pi-research:
            // getBrowserProfileDir mkdirs its result, and a unit test must not
            // leave artifacts in the user's actual cache tree.
            // A directory of our OWN via mkdtemp — NOT nested under the shared
            // <tmpdir>/pi-research-test that unit-env.ts routes the whole suite's
            // log file into. The old cleanup removed that shared directory
            // recursively, which both deleted the live log out from under every
            // parallel worker and raced the lazy logger re-creating it
            // mid-removal: ENOTEMPTY on macos-latest CI, 2026-08-26.
            const own = mkdtempSync(join(tmpdir(), 'pi-research-profilecontain-'));
            const custom = join(own, 'profiles-test-override');
            try {
                expect(getBrowserProfileDir({ TMP_DIR: custom } as any)).toBe(
                    join(custom, 'pi-research', 'profiles')
                );
            } finally {
                rmSync(own, { recursive: true, force: true });
            }
        });
    });

    describe('resolveHeadlessMode', () => {
        const savedDisplay = process.env['DISPLAY'];
        const savedWayland = process.env['WAYLAND_DISPLAY'];
        const savedUseXvfb = process.env['PI_RESEARCH_USE_XVFB'];

        afterEach(() => {
            if (savedDisplay === undefined) delete process.env['DISPLAY'];
            else process.env['DISPLAY'] = savedDisplay;
            if (savedWayland === undefined) delete process.env['WAYLAND_DISPLAY'];
            else process.env['WAYLAND_DISPLAY'] = savedWayland;
            if (savedUseXvfb === undefined) delete process.env['PI_RESEARCH_USE_XVFB'];
            else process.env['PI_RESEARCH_USE_XVFB'] = savedUseXvfb;
        });

        it('returns true on macOS — native headless works', () => {
            osMock.current = 'darwin';
            delete process.env['DISPLAY'];
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns true on Windows — true headless, no visible window (camoufox >=0.10 fixed the old crash)', () => {
            osMock.current = 'win32';
            delete process.env['DISPLAY'];
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns true on Linux when DISPLAY is set (X11 or XWayland)', () => {
            osMock.current = 'linux';
            process.env['DISPLAY'] = ':0';
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns true on Linux when DISPLAY is set to a CI-injected Xvfb value', () => {
            osMock.current = 'linux';
            process.env['DISPLAY'] = ':99';
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns true on Linux with only WAYLAND_DISPLAY set (pure Wayland)', () => {
            // JS camoufox-js does not strip WAYLAND_DISPLAY before spawning Xvfb, so
            // headless:'virtual' is unreliable on pure Wayland. headless:true works natively.
            osMock.current = 'linux';
            delete process.env['DISPLAY'];
            process.env['WAYLAND_DISPLAY'] = 'wayland-0';
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns true on Linux TTY by default (no DISPLAY/WAYLAND) — true headless needs no Xvfb', () => {
            osMock.current = 'linux';
            delete process.env['DISPLAY'];
            delete process.env['WAYLAND_DISPLAY'];
            delete process.env['PI_RESEARCH_USE_XVFB'];
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns "virtual" on Linux TTY only with the PI_RESEARCH_USE_XVFB=true opt-in', () => {
            osMock.current = 'linux';
            delete process.env['DISPLAY'];
            delete process.env['WAYLAND_DISPLAY'];
            process.env['PI_RESEARCH_USE_XVFB'] = 'true';
            expect(resolveHeadlessMode()).toBe('virtual');
        });
    });

    describe('getCamoufoxBinaryPath', () => {
        it('PLAYWRIGHT_BROWSERS_PATH relocates the cache HOME on Linux (same answer as getBrowserCacheDir)', () => {
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/override/path';
            expect(getCamoufoxBinaryPath()).toBe(join(resolve('/override/path'), 'camoufox'));
            expect(getCamoufoxBinaryPath()).toBe(getBrowserCacheDir());
        });

        it('Linux: defaults to ~/.cache/camoufox', () => {
            osMock.current = 'linux';
            expect(getCamoufoxBinaryPath()).toBe(join(homedir(), '.cache', 'camoufox'));
        });

        it('Linux: honors XDG_CACHE_HOME', () => {
            osMock.current = 'linux';
            process.env['XDG_CACHE_HOME'] = '/xdg/cache';
            expect(getCamoufoxBinaryPath()).toBe(join('/xdg/cache', 'camoufox'));
        });

        it('macOS: uses ~/Library/Caches/camoufox', () => {
            osMock.current = 'darwin';
            expect(getCamoufoxBinaryPath()).toBe(join(homedir(), 'Library', 'Caches', 'camoufox'));
        });

        it('Windows: mirrors @camoufox/camoufox userCacheDir (doubled camoufox segment, homedir fallback)', () => {
            osMock.current = 'win32';
            delete process.env['LOCALAPPDATA'];
            expect(getCamoufoxBinaryPath()).toBe(
                join(homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
            );
        });

        it('Windows: honours an absolute LOCALAPPDATA', () => {
            osMock.current = 'win32';
            process.env['LOCALAPPDATA'] = join('D:', 'Other', 'AppData', 'Local');
            expect(getCamoufoxBinaryPath()).toBe(
                join('D:', 'Other', 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
            );
        });

        it('macOS and Windows resolve to distinct paths (branch divergence)', () => {
            osMock.current = 'darwin';
            const mac = getCamoufoxBinaryPath();
            osMock.current = 'win32';
            process.env['LOCALAPPDATA'] = join('C:', 'Users', 'test', 'AppData', 'Local');
            const win = getCamoufoxBinaryPath();
            expect(mac).not.toBe(win);
        });
    });
});
