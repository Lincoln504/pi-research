import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBrowserCacheDir, getBrowserEnv, PROJECT_ROOT } from '../../../src/infrastructure/browser-config.ts';
import { join } from 'node:path';
import { platform } from 'node:os';

describe('browser-config', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.PLAYWRIGHT_BROWSERS_PATH = '';
        process.env.HOME = '/home/user';
        process.env.USERPROFILE = 'C:\\Users\\user';
    });

    it('should return project-local .browser directory by default', () => {
        const expected = join(PROJECT_ROOT, '.browser');
        expect(getBrowserCacheDir()).toBe(expected);
    });

    it('should respect PLAYWRIGHT_BROWSERS_PATH environment variable', () => {
        const customPath = '/custom/path';
        process.env.PLAYWRIGHT_BROWSERS_PATH = customPath;
        expect(getBrowserCacheDir()).toBe(customPath);
    });

    it('should return correct environment variables for redirection', () => {
        const env = getBrowserEnv();
        const cacheDir = getBrowserCacheDir();
        
        expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(cacheDir);
        if (platform() === 'win32') {
            expect(env.USERPROFILE).toBe(cacheDir);
        } else {
            expect(env.HOME).toBe(cacheDir);
        }
    });
});
