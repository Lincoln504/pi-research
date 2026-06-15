import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Deterministically control os.platform() so every platform branch of the
// path-resolution logic is exercised on any host. CI runs on Linux, so without
// this the darwin/win32 branches would never execute (the previous tests
// early-returned on non-matching platforms and asserted nothing).
const osMock = vi.hoisted(() => ({ current: 'linux' as NodeJS.Platform }));
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, platform: () => osMock.current };
});

import { getBrowserCacheDir, getBrowserEnv, getCamoufoxBinaryPath, resolveHeadlessMode } from '../../../src/infrastructure/browser/config.ts';

describe('browser-config', () => {
    const ENV_KEYS = ['PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME', 'LOCALAPPDATA'] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        osMock.current = 'linux';
        for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
        delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
        delete process.env['XDG_CACHE_HOME'];
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    describe('getBrowserCacheDir', () => {
        it('PLAYWRIGHT_BROWSERS_PATH overrides every platform default', () => {
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/my/browser/path';
            expect(getBrowserCacheDir()).toBe('/my/browser/path');
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

        it('Windows: mirrors camoufox-js userCacheDir (doubled camoufox segment, homedir-based)', () => {
            osMock.current = 'win32';
            // camoufox-js installs to homedir()/AppData/Local/camoufox/camoufox/Cache
            // and ignores %LOCALAPPDATA%, so detection must do the same.
            expect(getBrowserCacheDir()).toBe(
                join(homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
            );
        });

        it('Windows: ignores LOCALAPPDATA (camoufox-js uses homedir, not %LOCALAPPDATA%)', () => {
            osMock.current = 'win32';
            process.env['LOCALAPPDATA'] = join('D:', 'Other', 'AppData', 'Local');
            expect(getBrowserCacheDir()).toBe(
                join(homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
            );
        });
    });

    describe('getBrowserEnv', () => {
        it('omits PLAYWRIGHT_BROWSERS_PATH when not set', () => {
            const env = getBrowserEnv();
            expect(env['PLAYWRIGHT_BROWSERS_PATH']).toBeUndefined();
        });

        it('passes through PLAYWRIGHT_BROWSERS_PATH when explicitly set', () => {
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/custom/browser-cache';
            const env = getBrowserEnv();
            expect(env['PLAYWRIGHT_BROWSERS_PATH']).toBe('/custom/browser-cache');
        });

        it('preserves HOME and USERPROFILE unchanged', () => {
            const env = getBrowserEnv();
            expect(env['HOME']).toBe(process.env['HOME']);
            expect(env['USERPROFILE']).toBe(process.env['USERPROFILE']);
        });
    });

    describe('resolveHeadlessMode', () => {
        const savedDisplay = process.env['DISPLAY'];

        afterEach(() => {
            if (savedDisplay === undefined) delete process.env['DISPLAY'];
            else process.env['DISPLAY'] = savedDisplay;
        });

        it('returns true on macOS regardless of DISPLAY', () => {
            osMock.current = 'darwin';
            delete process.env['DISPLAY'];
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns true on Windows regardless of DISPLAY', () => {
            osMock.current = 'win32';
            delete process.env['DISPLAY'];
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns true on Linux when DISPLAY is set (X11 or XWayland)', () => {
            osMock.current = 'linux';
            process.env['DISPLAY'] = ':0';
            expect(resolveHeadlessMode()).toBe(true);
        });

        it('returns "virtual" on Linux when DISPLAY is not set (TTY or Wayland without XWayland)', () => {
            osMock.current = 'linux';
            delete process.env['DISPLAY'];
            expect(resolveHeadlessMode()).toBe('virtual');
        });

        it('returns true on Linux when DISPLAY is set to a CI-injected Xvfb value', () => {
            osMock.current = 'linux';
            process.env['DISPLAY'] = ':99';
            expect(resolveHeadlessMode()).toBe(true);
        });
    });

    describe('getCamoufoxBinaryPath', () => {
        it('PLAYWRIGHT_BROWSERS_PATH override wins on every platform', () => {
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/override/path';
            expect(getCamoufoxBinaryPath()).toBe('/override/path');
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

        it('Windows: mirrors camoufox-js userCacheDir (doubled camoufox segment, homedir-based)', () => {
            osMock.current = 'win32';
            expect(getCamoufoxBinaryPath()).toBe(
                join(homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
            );
        });

        it('Windows: ignores LOCALAPPDATA (camoufox-js uses homedir, not %LOCALAPPDATA%)', () => {
            osMock.current = 'win32';
            process.env['LOCALAPPDATA'] = join('D:', 'Other', 'AppData', 'Local');
            expect(getCamoufoxBinaryPath()).toBe(
                join(homedir(), 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
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
