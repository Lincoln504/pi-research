import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getBrowserCacheDir, getBrowserEnv, getCamoufoxBinaryPath } from '../../../src/infrastructure/browser-config.ts';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

describe('browser-config', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        savedEnv['PLAYWRIGHT_BROWSERS_PATH'] = process.env['PLAYWRIGHT_BROWSERS_PATH'];
        savedEnv['XDG_CACHE_HOME'] = process.env['XDG_CACHE_HOME'];
        savedEnv['LOCALAPPDATA'] = process.env['LOCALAPPDATA'];
        delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
        delete process.env['XDG_CACHE_HOME'];
    });

    afterEach(() => {
        process.env['PLAYWRIGHT_BROWSERS_PATH'] = savedEnv['PLAYWRIGHT_BROWSERS_PATH'];
        process.env['XDG_CACHE_HOME'] = savedEnv['XDG_CACHE_HOME'];
        process.env['LOCALAPPDATA'] = savedEnv['LOCALAPPDATA'];
        if (process.env['PLAYWRIGHT_BROWSERS_PATH'] === undefined) delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
        if (process.env['XDG_CACHE_HOME'] === undefined) delete process.env['XDG_CACHE_HOME'];
        if (process.env['LOCALAPPDATA'] === undefined) delete process.env['LOCALAPPDATA'];
    });

    describe('getBrowserCacheDir', () => {
        it('returns platform-specific default on Linux', () => {
            if (platform() !== 'linux') return;
            expect(getBrowserCacheDir()).toBe(join(homedir(), '.cache', 'camoufox'));
        });

        it('returns XDG_CACHE_HOME-based path when XDG_CACHE_HOME is set (Linux)', () => {
            if (platform() !== 'linux') return;
            process.env['XDG_CACHE_HOME'] = '/custom/cache';
            expect(getBrowserCacheDir()).toBe('/custom/cache/camoufox');
        });

        it('returns PLAYWRIGHT_BROWSERS_PATH when set', () => {
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/my/browser/path';
            expect(getBrowserCacheDir()).toBe('/my/browser/path');
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

    describe('getCamoufoxBinaryPath', () => {
        it('returns PLAYWRIGHT_BROWSERS_PATH override when set', () => {
            process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/override/path';
            expect(getCamoufoxBinaryPath()).toBe('/override/path');
        });

        it('returns platform-specific default on Linux (XDG_CACHE_HOME not set)', () => {
            if (platform() !== 'linux') return;
            expect(getCamoufoxBinaryPath()).toBe(join(homedir(), '.cache', 'camoufox'));
        });

        it('returns XDG_CACHE_HOME-based path on Linux when XDG_CACHE_HOME is set', () => {
            if (platform() !== 'linux') return;
            process.env['XDG_CACHE_HOME'] = '/xdg/cache';
            expect(getCamoufoxBinaryPath()).toBe('/xdg/cache/camoufox');
        });

        it('returns macOS Library/Caches path on darwin', () => {
            if (platform() !== 'darwin') return;
            expect(getCamoufoxBinaryPath()).toBe(join(homedir(), 'Library', 'Caches', 'camoufox'));
        });

        it('returns LOCALAPPDATA-based path on Windows when LOCALAPPDATA is set', () => {
            if (platform() !== 'win32') return;
            process.env['LOCALAPPDATA'] = 'C:\\Users\\test\\AppData\\Local';
            expect(getCamoufoxBinaryPath()).toBe('C:\\Users\\test\\AppData\\Local\\camoufox\\Cache');
        });

        it('falls back to homedir AppData path on Windows when LOCALAPPDATA is not set', () => {
            if (platform() !== 'win32') return;
            delete process.env['LOCALAPPDATA'];
            expect(getCamoufoxBinaryPath()).toBe(join(homedir(), 'AppData', 'Local', 'camoufox', 'Cache'));
        });
    });
});
