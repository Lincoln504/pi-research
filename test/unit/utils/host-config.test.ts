/**
 * getConfigDirName() — PI_RESEARCH_CONFIG_DIR_NAME must be a bare directory
 * name, never a path.
 *
 * Regression: the override was joined onto os.homedir() (getGlobalConfigDir()
 * in config.ts) with zero validation — the base for config.env (API keys,
 * chmod 0600), the state dir, and knowledge_db. A value like `../../tmp/evil`
 * traverses out of HOME entirely. scripts/cleanup.cjs already rejects exactly
 * this in its own copy of the same resolution; this file's copy — the one
 * every actual run resolves secrets and state through — did not.
 *
 * Each test re-imports the module after vi.resetModules(): getConfigDirName()
 * memoizes its result in a module-level variable on first call, so a stale
 * import would carry over the previous test's env var.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_KEY = 'PI_RESEARCH_CONFIG_DIR_NAME';
const saved = process.env[ENV_KEY];

async function importFresh() {
  const { vi } = await import('vitest');
  vi.resetModules();
  return import('../../../src/utils/host-config.ts');
}

describe('getConfigDirName — override sanitization', () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it('accepts a bare directory name', async () => {
    process.env[ENV_KEY] = 'my-custom-dir';
    const { getConfigDirName } = await importFresh();
    expect(getConfigDirName()).toBe('my-custom-dir');
  });

  it.each([
    ['../../tmp/evil', 'parent-traversal'],
    ['/etc/passwd', 'absolute unix path'],
    ['..\\..\\evil', 'parent-traversal (backslash)'],
    ['foo/bar', 'embedded forward slash'],
    ['foo\\bar', 'embedded backslash'],
    ['.', 'bare dot'],
    ['..', 'bare dot-dot'],
  ])('rejects %s (%s) and falls back rather than traversing out of HOME', async (unsafe) => {
    process.env[ENV_KEY] = unsafe;
    const { getConfigDirName } = await importFresh();
    const result = getConfigDirName();
    expect(result).not.toBe(unsafe);
    expect(result.includes('/')).toBe(false);
    expect(result.includes('\\')).toBe(false);
  });
});
