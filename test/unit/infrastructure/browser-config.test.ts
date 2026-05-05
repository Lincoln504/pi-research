import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBrowserCacheDir, getBrowserEnv, getCamoufoxBinaryPath } from '../../../src/infrastructure/browser-config.ts';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

describe('browser-config', () => {
    beforeEach(() => {
        vi.resetModules();
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    });

    it('should return the user home directory by default', () => {
        expect(getBrowserCacheDir()).toBe(homedir());
    });

    it('should respect PLAYWRIGHT_BROWSERS_PATH environment variable', () => {
        const customPath = join('custom', 'path');
        process.env.PLAYWRIGHT_BROWSERS_PATH = customPath;
        expect(getBrowserCacheDir()).toBe(customPath);
    });

    it('should not redirect home environment variables by default', () => {
        const env = getBrowserEnv();
        expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
        expect(env.HOME).toBe(process.env.HOME);
        expect(env.USERPROFILE).toBe(process.env.USERPROFILE);
    });

    it('should pass through explicit browser cache overrides', () => {
        const customPath = join('custom', 'browser-cache');
        process.env.PLAYWRIGHT_BROWSERS_PATH = customPath;

        const env = getBrowserEnv();

        expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(customPath);
    });

    it('should compute the platform-specific camoufox binary path', () => {
        const base = homedir();
        const expected = platform() === 'win32'
            ? join(base, 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache')
            : platform() === 'darwin'
                ? join(base, 'Library', 'Caches', 'camoufox')
                : join(base, '.cache', 'camoufox');

        expect(getCamoufoxBinaryPath()).toBe(expected);
    });
});
