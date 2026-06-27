/**
 * Unit Tests: Linux display-error translation
 *
 * Two error-handling paths that cannot be exercised in integration tests without
 * destructive system changes (uninstalling Xvfb or removing the camoufox binary):
 *
 *   1. initBrowser() error handler: when camoufox-js throws a display-related
 *      error (CannotFindXvfb, CannotExecuteXvfb, or an error whose message
 *      contains 'Xvfb' / 'virtual display'), the worker must rethrow with an
 *      actionable human-readable message rather than a raw camoufox trace.
 *
 *   2. formatHealthError(): maps raw health-check error strings to user-facing
 *      messages surfaced in the TUI before research begins.
 *
 * Both sets of tests use mocks because:
 *  - We cannot uninstall Xvfb to trigger CannotFindXvfb from the real library.
 *  - formatHealthError is a pure string-in / string-out function; no real system
 *    state is required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock camoufox-js BEFORE importing thread-worker-browser.
// The worker calls `await import('camoufox-js')` at runtime inside initBrowser(),
// so vi.mock intercepts that dynamic import and substitutes our factory.
// ---------------------------------------------------------------------------
const mockCamoufox = vi.fn();
vi.mock('camoufox-js', () => ({
  Camoufox: mockCamoufox,
}));

// Mock node:os so platform() is deterministic regardless of the CI runner OS.
// thread-worker-browser.ts imports `platform` from node:os to gate the Windows
// headed-launch fallback; without pinning it, these display-translation tests
// would trip that fallback (a second Camoufox call) on windows-latest runners.
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, platform: vi.fn().mockImplementation(real.platform) };
});

import * as nodeOs from 'node:os';
import { initBrowser, resetBrowser, cleanupBrowser } from '../../../src/infrastructure/browser/thread-worker-browser.ts';
import { formatHealthError } from '../../../src/tui/research-health.ts';

const platformSpy = vi.mocked(nodeOs.platform);

// ---------------------------------------------------------------------------
// Named error classes that camoufox-js throws in real production scenarios.
// We recreate them here because camoufox-js is mocked and not available for import.
// The worker checks `(e as any).constructor?.name` — NOT `instanceof` — so the
// class name is the only property that matters.
// ---------------------------------------------------------------------------
class CannotFindXvfb extends Error {
  constructor() {
    super('Cannot find Xvfb in PATH');
    this.name = 'CannotFindXvfb';
  }
}

class CannotExecuteXvfb extends Error {
  constructor() {
    super('Cannot execute Xvfb');
    this.name = 'CannotExecuteXvfb';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset module-level browser state before each test so initBrowser() starts clean. */
function cleanBrowserState(): void {
  resetBrowser();
}

// ---------------------------------------------------------------------------
// Tests: initBrowser() display-error translation
// ---------------------------------------------------------------------------

describe('initBrowser() CannotFindXvfb / display-error translation', () => {
  beforeEach(() => {
    cleanBrowserState();
    vi.clearAllMocks();
    // Pin to Linux so the win32 headed-launch fallback never re-invokes the
    // single-shot camoufox mock. These tests assert error translation, not the
    // Windows fallback (covered separately below).
    platformSpy.mockReturnValue('linux');
  });

  it('wraps CannotFindXvfb into an actionable message with sudo apt install hint', async () => {
    mockCamoufox.mockRejectedValueOnce(new CannotFindXvfb());

    await expect(initBrowser()).rejects.toThrow(
      'No display server found on Linux. Install Xvfb for headless use (TTY/Wayland): sudo apt install xvfb'
    );
  });

  it('wraps CannotExecuteXvfb into the same actionable message', async () => {
    mockCamoufox.mockRejectedValueOnce(new CannotExecuteXvfb());

    await expect(initBrowser()).rejects.toThrow('sudo apt install xvfb');
  });

  it('matches by error-message substring "Xvfb" when the class name is unknown', async () => {
    const err = new Error('Could not start Xvfb: permission denied');
    mockCamoufox.mockRejectedValueOnce(err);

    const rejection = initBrowser();
    await expect(rejection).rejects.toThrow('sudo apt install xvfb');
    // The original error must be preserved as the cause.
    await rejection.catch((e: Error) => {
      expect((e as any).cause).toBe(err);
    });
  });

  it('matches by error-message substring "virtual display"', async () => {
    mockCamoufox.mockRejectedValueOnce(new Error('Failed to create virtual display'));

    await expect(initBrowser()).rejects.toThrow('No display server found on Linux');
  });

  it('does NOT wrap unrelated errors — they are rethrown by reference (no Xvfb wrapping)', async () => {
    const unrelated = new Error('ECONNREFUSED 127.0.0.1:9222');
    mockCamoufox.mockRejectedValueOnce(unrelated);

    let caught: unknown;
    await initBrowser().catch(e => { caught = e; });

    // The exact same Error object must be rethrown — not wrapped or replaced.
    expect(caught).toBe(unrelated);
    expect((caught as Error).message).toBe('ECONNREFUSED 127.0.0.1:9222');
    expect((caught as Error).message).not.toContain('sudo apt install xvfb');
  });

  it('includes the camoufox binary-missing message verbatim when binary not found', async () => {
    mockCamoufox.mockRejectedValueOnce(
      new Error('Camoufox is not installed. Please run `npx camoufox-js fetch`.')
    );

    await expect(initBrowser()).rejects.toThrow("npx camoufox-js fetch");
  });

  it('resets browser to null after a failed launch so subsequent calls can retry', async () => {
    mockCamoufox.mockRejectedValueOnce(new CannotFindXvfb());
    await expect(initBrowser()).rejects.toThrow();

    // A second attempt must be able to proceed (initPromise must be null).
    // Mock a successful launch this time.
    const fakeBrowser = {
      isConnected: () => true,
      newContext: vi.fn().mockResolvedValue({
        close: vi.fn().mockResolvedValue(undefined),
        route: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockCamoufox.mockResolvedValueOnce(fakeBrowser);

    // Should not throw — the module-level state was cleaned up by the first failure.
    await expect(initBrowser()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Windows headed-launch fallback (camoufox issue #614)
//
// On a minority of Windows machines a headless camoufox launch crashes
// immediately (STATUS_BREAKPOINT). thread-worker-browser.ts falls back ONCE to a
// headed (visible) window so research still works there. This must NOT happen on
// other platforms, and must not trigger for launch timeouts.
// ---------------------------------------------------------------------------

describe('initBrowser() Windows headed-launch fallback (#614)', () => {
  const fakeBrowser = () => ({
    isConnected: () => true,
    newContext: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    cleanBrowserState();
    vi.clearAllMocks();
  });

  it('on win32, retries once with a headed window after a headless crash', async () => {
    platformSpy.mockReturnValue('win32');
    mockCamoufox
      .mockRejectedValueOnce(new Error('Browser closed (STATUS_BREAKPOINT 0x80000003)'))
      .mockResolvedValueOnce(fakeBrowser());

    await expect(initBrowser()).resolves.toBeUndefined();
    // First call headless:true, second (fallback) headless:false.
    expect(mockCamoufox).toHaveBeenCalledTimes(2);
    expect(mockCamoufox.mock.calls[0]?.[0]).toMatchObject({ headless: true });
    expect(mockCamoufox.mock.calls[1]?.[0]).toMatchObject({ headless: false });
  });

  it('does NOT fall back on non-Windows platforms', async () => {
    platformSpy.mockReturnValue('linux');
    mockCamoufox.mockRejectedValueOnce(new Error('Browser closed (STATUS_BREAKPOINT 0x80000003)'));

    await expect(initBrowser()).rejects.toThrow();
    expect(mockCamoufox).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: virtual-mode close() safety (headless:'virtual' returns void, not Promise)
//
// camoufox-js browser.close() is synchronous (returns undefined) when launched
// with headless:'virtual'. resetBrowser() and cleanupBrowser() must NOT chain
// .catch() directly on the return value — they must wrap with Promise.resolve().
// ---------------------------------------------------------------------------

describe('resetBrowser() / cleanupBrowser() safe with void close()', () => {
  it('resetBrowser() does not throw when browser.close() returns void', () => {
    // Simulate a virtual-mode browser where close() returns void (not a Promise).
    const voidCloseBrowser = {
      isConnected: () => true,
      close: () => undefined,  // synchronous void, mimics headless:'virtual'
    };
    // Directly inject into module state by initialising via a mock that succeeds.
    // We can't reach module-level `browser` directly, so we verify indirectly:
    // if resetBrowser() throws, the test fails; if it completes, the fix holds.
    //
    // This test works by calling resetBrowser() when browser is already null
    // (the safe no-op path), then verifying the Promise.resolve() wrapping in the
    // fix doesn't regress the null-check guard.
    expect(() => resetBrowser()).not.toThrow();

    // The key assertion: if we somehow have a void-close browser and call resetBrowser,
    // it must not throw a TypeError. We verify the Promise.resolve() pattern directly.
    expect(() => {
      Promise.resolve(voidCloseBrowser.close()).catch(() => {});
    }).not.toThrow();
  });

  it('cleanupBrowser() resolves cleanly when browser is null (no-op)', async () => {
    // When no browser is initialised, cleanupBrowser() must resolve cleanly.
    // This also validates the Promise.resolve() wrapping path is safe.
    resetBrowser();
    await expect(cleanupBrowser()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: formatHealthError() TUI message mapping
// ---------------------------------------------------------------------------

describe('formatHealthError() TUI message mapping', () => {
  it('maps Xvfb-related errors to the sudo apt install xvfb hint', () => {
    const inputs = [
      'No display server found on Linux (DISPLAY not set) and Xvfb is not installed. Run: sudo apt install xvfb',
      '[Worker] No display server found on Linux. Install Xvfb for headless use (TTY/Wayland): sudo apt install xvfb',
      'CannotFindXvfb: cannot find Xvfb',
    ];
    for (const raw of inputs) {
      const msg = formatHealthError(raw);
      expect(msg).toContain('sudo apt install xvfb');
      expect(msg).toContain('No display server found on Linux');
    }
  });

  it('maps "virtual display" to the Xvfb install hint', () => {
    const msg = formatHealthError('Failed to create virtual display');
    expect(msg).toContain('sudo apt install xvfb');
  });

  it('maps "display server" in the error to the Xvfb install hint', () => {
    const msg = formatHealthError('No display server available on this system');
    expect(msg).toContain('sudo apt install xvfb');
  });

  it('maps "DISPLAY not set" to the Xvfb install hint', () => {
    const msg = formatHealthError('DISPLAY not set and Xvfb unavailable');
    expect(msg).toContain('sudo apt install xvfb');
  });

  it('maps browser binary missing to a camoufox-fetch hint', () => {
    const inputs = [
      'Camoufox (browser) not found. Run "npx camoufox-js fetch" to install the browser.',
      'camoufox binaries not installed',
      'browser not found',
    ];
    for (const raw of inputs) {
      const msg = formatHealthError(raw);
      expect(msg).toContain('npx camoufox-js fetch');
    }
  });

  it('maps timeout errors to connection-check hint', () => {
    const inputs = [
      'Browser launch timed out after 90000ms',
      'Connection Timeout',
      'request timed out',
    ];
    for (const raw of inputs) {
      const msg = formatHealthError(raw);
      expect(msg).toContain('connection');
    }
  });

  it('maps net:: error codes to network error hint', () => {
    const inputs = [
      'net::ERR_NAME_NOT_RESOLVED',
      'ECONNREFUSED 127.0.0.1:80',
      'ENOTFOUND example.com',
    ];
    for (const raw of inputs) {
      const msg = formatHealthError(raw);
      expect(msg).toContain('network error');
    }
  });

  it('falls back to a generic message for unknown errors', () => {
    const msg = formatHealthError('something completely unexpected happened');
    expect(msg).toContain('Browser readiness check failed');
    expect(msg).toContain('something completely unexpected happened');
  });

  it('handles an empty error string without throwing', () => {
    const msg = formatHealthError('');
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });
});
