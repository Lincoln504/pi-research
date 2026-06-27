/**
 * Tests for runtime browser provisioning (ensureBrowserInstalled).
 *
 * The regression-critical guarantees:
 *  - When the browser is already present (every postinstall-run install path:
 *    pi extension, plain npm), it is a no-op and NEVER spawns a fetch.
 *  - When PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 (CI / unit tests), it never fetches.
 *  - Only when the binary is genuinely absent AND not skipped does it fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const existsSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const statSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
  readdirSync: (...a: unknown[]) => readdirSyncMock(...a),
  statSync: (...a: unknown[]) => statSyncMock(...a),
  openSync: vi.fn(() => 1),
  closeSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('../../../src/infrastructure/browser/config.ts', () => ({
  getCamoufoxBinaryPath: vi.fn(() => '/fake/cache/camoufox'),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

/** Make spawn resolve as a successful child process. */
function spawnSucceeds(): void {
  spawnMock.mockImplementation(() => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    queueMicrotask(() => handlers['exit']?.(0));
    return { on: (ev: string, cb: (arg?: unknown) => void) => { handlers[ev] = cb; }, kill: vi.fn() };
  });
}

async function freshModule() {
  vi.resetModules();
  return await import('../../../src/infrastructure/browser/ensure-browser.ts');
}

describe('ensureBrowserInstalled', () => {
  const savedSkip = process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];

  beforeEach(() => {
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
    statSyncMock.mockReset();
    spawnSucceeds();
    // statSync used for both version-dir detection and lock staleness.
    statSyncMock.mockReturnValue({ isDirectory: () => true, mtimeMs: Date.now() });
  });

  afterEach(() => {
    if (savedSkip === undefined) delete process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];
    else process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = savedSkip;
  });

  it('is a no-op (no fetch) when the browser binary is already present', async () => {
    delete process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];
    existsSyncMock.mockReturnValue(true);             // cache dir exists
    readdirSyncMock.mockReturnValue(['1.2.3']);       // has a version subdir
    const { ensureBrowserInstalled } = await freshModule();
    await ensureBrowserInstalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('never fetches when PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, even if absent', async () => {
    process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = '1';
    existsSyncMock.mockReturnValue(false);            // cache dir absent
    readdirSyncMock.mockReturnValue([]);
    const { ensureBrowserInstalled } = await freshModule();
    await ensureBrowserInstalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fetches exactly once when the binary is absent and not skipped', async () => {
    delete process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];
    // Absent at first (present-check + re-check under lock both false); the fetch
    // path runs. existsSync false throughout keeps it from short-circuiting.
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue([]);
    const { ensureBrowserInstalled } = await freshModule();
    await ensureBrowserInstalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('fetch');
  });

  it('dedupes concurrent callers into a single fetch', async () => {
    delete process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue([]);
    const { ensureBrowserInstalled } = await freshModule();
    await Promise.all([ensureBrowserInstalled(), ensureBrowserInstalled(), ensureBrowserInstalled()]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
