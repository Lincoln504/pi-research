/**
 * Integration Tests: Linux Display-Mode Compatibility
 *
 * These tests cover code paths that are dead in every existing test run.
 * CI injects DISPLAY=:99; local dev has DISPLAY=:0.0 — so resolveHeadlessMode()
 * always returns `true`, the `'virtual'` branch never executes, and the
 * BrowserCapability `which Xvfb` gate is never reached.
 *
 * What is tested here that nothing else tests:
 *
 *   1. camoufox launches successfully with headless:'virtual' when DISPLAY is unset
 *      — the first real execution of this code path that proves the TTY / Wayland
 *      user journey actually works end-to-end.
 *
 *   2. A complete scrape pipeline (local HTTP server → camoufox → markdown
 *      extraction) using the virtual display, with DISPLAY absent throughout.
 *
 *   3. BrowserCapability health check scenarios:
 *        (A) TTY + Xvfb present → healthy:true  (real which Xvfb call)
 *        (B) TTY + Xvfb absent  → healthy:false with actionable install hint (mocked)
 *        (C) DISPLAY set        → which Xvfb is NOT called at all
 *        (C2) pure Wayland      → which Xvfb is NOT called (headless:true used instead)
 *        (D) binary absent      → healthy:false with npm run setup hint
 *
 * Skip semantics: every test uses ctx.skip() — never a silent pass-green.
 * Platform guard:  Linux-only tests are skipped via ctx.skip() on non-Linux,
 *                  not by early-returning (which would hide the skip from reporters).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { resolveHeadlessMode, isBrowserAvailable } from '../../src/infrastructure/browser/config.ts';
import { checkBrowserCapability } from '../../src/healthcheck/index.ts';

// ---------------------------------------------------------------------------
// execFileSync spy
//
// We intercept node:child_process so we can:
//   (a) assert that `which Xvfb` is NOT called when DISPLAY is set, and
//   (b) simulate a missing Xvfb binary without uninstalling the real one.
//
// The default mock implementation is a pass-through to the real function, so
// every test that doesn't override it gets real system behaviour (including
// camoufox's own internal uses of child_process).
// ---------------------------------------------------------------------------
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, execFileSync: vi.fn().mockImplementation(real.execFileSync) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when Xvfb is actually installed on this machine. */
function xvfbInstalled(): boolean {
  try {
    execFileSync('which', ['Xvfb'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Page content for the virtual-mode scrape test.
const VIRTUAL_SCRAPE_MARKER = 'VirtualScrapeMarker_9b2e47f3';
const LOCAL_PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Virtual Display Test Page</title></head>
<body><main>
<h1>Virtual Display Integration Test</h1>
<p>${VIRTUAL_SCRAPE_MARKER}. This page is served by a localhost HTTP server so
the integration suite can verify that camoufox launches, navigates, and renders
content correctly when running under a Xvfb virtual display (headless:'virtual')
with no real DISPLAY variable present. The paragraph is intentionally long so
content-validation heuristics in the scrape pipeline accept it as genuine text
rather than rejecting it as a bot-challenge interstitial or empty stub.</p>
</main></body></html>`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Linux display-mode integration tests', () => {
  const originalDisplay = process.env['DISPLAY'];
  const originalWaylandDisplay = process.env['WAYLAND_DISPLAY'];

  afterEach(() => {
    // Restore display env after every test so tests don't cross-contaminate.
    if (originalDisplay === undefined) {
      delete process.env['DISPLAY'];
    } else {
      process.env['DISPLAY'] = originalDisplay;
    }
    if (originalWaylandDisplay === undefined) {
      delete process.env['WAYLAND_DISPLAY'];
    } else {
      process.env['WAYLAND_DISPLAY'] = originalWaylandDisplay;
    }
    vi.mocked(execFileSync).mockClear();
  });

  // =========================================================================
  // Group 1: resolveHeadlessMode() runtime transitions
  //
  // The unit suite already covers branch logic. These tests verify that the
  // function is NOT cached: it must read process.env['DISPLAY'] on every
  // invocation so that a display-server becoming available mid-session is
  // reflected immediately.
  // =========================================================================

  describe('resolveHeadlessMode() runtime transitions', () => {
    it('returns "virtual" on Linux TTY (no DISPLAY and no WAYLAND_DISPLAY)', (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();

      delete process.env['DISPLAY'];
      delete process.env['WAYLAND_DISPLAY'];
      expect(resolveHeadlessMode()).toBe('virtual');
    });

    it('returns true on Linux when DISPLAY is set at runtime', (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();

      process.env['DISPLAY'] = ':0';
      expect(resolveHeadlessMode()).toBe(true);
    });

    it('transitions from true to "virtual" when DISPLAY is removed (TTY scenario)', (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();

      // Ensure no WAYLAND_DISPLAY so the second call lands in the true TTY case.
      delete process.env['WAYLAND_DISPLAY'];
      process.env['DISPLAY'] = ':99';
      expect(resolveHeadlessMode()).toBe(true);

      delete process.env['DISPLAY'];
      expect(resolveHeadlessMode()).toBe('virtual');
    });

    it('returns true when WAYLAND_DISPLAY is set but DISPLAY is absent (pure Wayland)', (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();

      delete process.env['DISPLAY'];
      process.env['WAYLAND_DISPLAY'] = 'wayland-0';
      // headless:true works natively on Wayland. headless:'virtual' is avoided here because
      // the JS camoufox port does not strip WAYLAND_DISPLAY / GDK_BACKEND / MOZ_ENABLE_WAYLAND
      // before spawning Xvfb, so Firefox may connect to the Wayland compositor instead of Xvfb.
      expect(resolveHeadlessMode()).toBe(true);
    });

    it('returns true when both DISPLAY and WAYLAND_DISPLAY are set (XWayland active)', (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();

      process.env['DISPLAY'] = ':0';
      process.env['WAYLAND_DISPLAY'] = 'wayland-0';
      expect(resolveHeadlessMode()).toBe(true);
    });
  });

  // =========================================================================
  // Group 2: camoufox virtual-mode launch
  //
  // These tests directly call camoufox-js (bypassing the browser pool) with
  // headless:'virtual' and no DISPLAY set. They prove the full Xvfb spawn-
  // and-kill lifecycle works correctly on this machine.
  //
  // Skip conditions (all must hold to run):
  //   - Linux
  //   - Xvfb installed
  //   - camoufox binary present (isBrowserAvailable or direct import check)
  //
  // Timeout: camoufox with Xvfb needs up to 60s on a cold machine.
  // =========================================================================

  describe('camoufox virtual-mode launch (Linux + Xvfb + binary required)', () => {
    it('launches a browser with headless:"virtual" when DISPLAY is absent', async (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();
      if (!xvfbInstalled()) return ctx.skip();
      if (!isBrowserAvailable()) return ctx.skip();

      // Simulate a TTY: remove both DISPLAY and WAYLAND_DISPLAY so resolveHeadlessMode()
      // returns 'virtual' (pure Wayland would return true and skip the virtual-mode path).
      delete process.env['DISPLAY'];
      delete process.env['WAYLAND_DISPLAY'];

      // Confirm the resolved mode — this is what the browser worker would pass.
      expect(resolveHeadlessMode()).toBe('virtual');

      const { Camoufox } = await import('camoufox-js');

      let browser: any;
      try {
        browser = await Camoufox({
          headless: 'virtual',
          humanize: false,
          locale: 'en-US',
        });

        // The browser must report itself as connected (not crashed or hung).
        expect(browser.isConnected()).toBe(true);

        // Must be able to create a context — this exercises the full IPC handshake.
        const context = await browser.newContext();
        expect(context).toBeDefined();
        await context.close();
      } finally {
        // camoufox-js virtual mode: close() is synchronous (returns undefined),
        // unlike the Promise-returning close() in headless:true mode.
        if (browser) try { await browser.close(); } catch {}
      }
    }, 90_000);

    it('fetches and renders a local HTTP page when using virtual-display mode', async (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();
      if (!xvfbInstalled()) return ctx.skip();
      if (!isBrowserAvailable()) return ctx.skip();

      // Start a local HTTP server that serves our marker page.
      const server: Server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LOCAL_PAGE_HTML);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/`;

      delete process.env['DISPLAY'];
      delete process.env['WAYLAND_DISPLAY'];
      expect(resolveHeadlessMode()).toBe('virtual');

      const { Camoufox } = await import('camoufox-js');

      let browser: any;
      let pageTitle: string | undefined;
      let pageContent: string | undefined;

      try {
        browser = await Camoufox({
          headless: 'virtual',
          humanize: false,
          locale: 'en-US',
        });

        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        pageTitle = await page.title();
        pageContent = await page.content();

        await page.close();
        await context.close();
      } finally {
        if (browser) try { await browser.close(); } catch {}
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // The real camoufox must have fetched, rendered, and returned our exact page.
      expect(pageTitle).toBe('Virtual Display Test Page');
      expect(pageContent).toContain(VIRTUAL_SCRAPE_MARKER);
      expect(pageContent).toContain('Virtual Display Integration Test');
    }, 90_000);
  });

  // =========================================================================
  // Group 3: BrowserCapability health-check scenarios
  //
  // Verifies all five branches of checkBrowserCapability():
  //   A. TTY (no DISPLAY, no WAYLAND_DISPLAY) + Xvfb installed  → healthy
  //   B. TTY + Xvfb absent (mocked)                             → unhealthy + apt hint
  //   C. DISPLAY set (X11/XWayland)                             → Xvfb check skipped
  //   C2. pure Wayland (WAYLAND_DISPLAY only, no DISPLAY)       → Xvfb check skipped
  //   D. browser binary absent                                   → unhealthy + setup hint
  //
  // Test B uses mockImplementationOnce to simulate a missing Xvfb binary
  // without actually uninstalling it. Every other call to execFileSync in this
  // file uses the real implementation.
  //
  // The tests use checkBrowserCapability() — the extracted, exported function
  // that registerHealthChecks() delegates to — so the assertions target the
  // exact code path that runs in production.
  // =========================================================================

  describe('BrowserCapability health check (Linux no-display scenarios)', () => {
    beforeEach(() => {
      vi.mocked(execFileSync).mockClear();
    });

    it('(A) passes when DISPLAY is absent (TTY) but Xvfb is installed', async (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();
      if (!xvfbInstalled()) return ctx.skip();
      if (!isBrowserAvailable()) return ctx.skip();

      // Simulate TTY: delete both DISPLAY and WAYLAND_DISPLAY so resolveHeadlessMode()
      // returns 'virtual' and the healthcheck calls which-Xvfb.
      delete process.env['DISPLAY'];
      delete process.env['WAYLAND_DISPLAY'];
      // Clear MOCK flags so isBrowserAvailable() path is taken, not the mockMode shortcut.
      const savedMockSearch = process.env['PI_RESEARCH_MOCK_SEARCH'];
      const savedMockScrape = process.env['PI_RESEARCH_MOCK_SCRAPE'];
      delete process.env['PI_RESEARCH_MOCK_SEARCH'];
      delete process.env['PI_RESEARCH_MOCK_SCRAPE'];

      let result: Awaited<ReturnType<typeof checkBrowserCapability>>;
      try {
        result = await checkBrowserCapability();
      } finally {
        if (savedMockSearch !== undefined) process.env['PI_RESEARCH_MOCK_SEARCH'] = savedMockSearch;
        else delete process.env['PI_RESEARCH_MOCK_SEARCH'];
        if (savedMockScrape !== undefined) process.env['PI_RESEARCH_MOCK_SCRAPE'] = savedMockScrape;
        else delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
      }

      expect(result.healthy).toBe(true);
      // The real `which Xvfb` was called and succeeded — spy confirms it ran.
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith('which', ['Xvfb'], { stdio: 'ignore' });
    });

    it('(B) fails with apt-install hint when DISPLAY is absent (TTY) and Xvfb is missing', async (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();
      if (!isBrowserAvailable()) return ctx.skip();

      // Simulate TTY: both display vars absent so resolveHeadlessMode() returns 'virtual'.
      delete process.env['DISPLAY'];
      delete process.env['WAYLAND_DISPLAY'];
      const savedMockSearch = process.env['PI_RESEARCH_MOCK_SEARCH'];
      const savedMockScrape = process.env['PI_RESEARCH_MOCK_SCRAPE'];
      delete process.env['PI_RESEARCH_MOCK_SEARCH'];
      delete process.env['PI_RESEARCH_MOCK_SCRAPE'];

      // Simulate `which Xvfb` failing (Xvfb not installed).
      // Only the `which Xvfb` call is overridden; every other execFileSync call
      // (e.g. from camoufox internals) still uses the real implementation.
      vi.mocked(execFileSync).mockImplementationOnce((cmd: any, args: any) => {
        if (cmd === 'which' && Array.isArray(args) && args[0] === 'Xvfb') {
          throw new Error('which: no Xvfb in PATH');
        }
        // Fallback: not expected to be reached in this code path, but safe to throw.
        throw new Error(`Unexpected execFileSync call in test: ${cmd} ${args}`);
      });

      let result: Awaited<ReturnType<typeof checkBrowserCapability>>;
      try {
        result = await checkBrowserCapability();
      } finally {
        if (savedMockSearch !== undefined) process.env['PI_RESEARCH_MOCK_SEARCH'] = savedMockSearch;
        else delete process.env['PI_RESEARCH_MOCK_SEARCH'];
        if (savedMockScrape !== undefined) process.env['PI_RESEARCH_MOCK_SCRAPE'] = savedMockScrape;
        else delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
      }

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('sudo apt install xvfb');
      expect(result.error).toContain('DISPLAY not set');
    });

    it('(C) does NOT call which-Xvfb when DISPLAY is set', async (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();
      if (!isBrowserAvailable()) return ctx.skip();

      process.env['DISPLAY'] = ':99';
      const savedMockSearch = process.env['PI_RESEARCH_MOCK_SEARCH'];
      const savedMockScrape = process.env['PI_RESEARCH_MOCK_SCRAPE'];
      delete process.env['PI_RESEARCH_MOCK_SEARCH'];
      delete process.env['PI_RESEARCH_MOCK_SCRAPE'];

      let result: Awaited<ReturnType<typeof checkBrowserCapability>>;
      try {
        result = await checkBrowserCapability();
      } finally {
        if (savedMockSearch !== undefined) process.env['PI_RESEARCH_MOCK_SEARCH'] = savedMockSearch;
        else delete process.env['PI_RESEARCH_MOCK_SEARCH'];
        if (savedMockScrape !== undefined) process.env['PI_RESEARCH_MOCK_SCRAPE'] = savedMockScrape;
        else delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
      }

      // With DISPLAY set, resolveHeadlessMode() returns true (not 'virtual'):
      // the Xvfb gate does not fire and `which Xvfb` must NOT have been called.
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalledWith('which', ['Xvfb'], expect.anything());
      expect(result.healthy).toBe(true);
    });

    it('(C2) does NOT call which-Xvfb on pure Wayland (WAYLAND_DISPLAY set, no DISPLAY)', async (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();
      if (!isBrowserAvailable()) return ctx.skip();

      // Pure Wayland: resolveHeadlessMode() returns true (not 'virtual'), so Xvfb is not needed.
      delete process.env['DISPLAY'];
      process.env['WAYLAND_DISPLAY'] = 'wayland-0';
      const savedMockSearch = process.env['PI_RESEARCH_MOCK_SEARCH'];
      const savedMockScrape = process.env['PI_RESEARCH_MOCK_SCRAPE'];
      delete process.env['PI_RESEARCH_MOCK_SEARCH'];
      delete process.env['PI_RESEARCH_MOCK_SCRAPE'];

      let result: Awaited<ReturnType<typeof checkBrowserCapability>>;
      try {
        result = await checkBrowserCapability();
      } finally {
        if (savedMockSearch !== undefined) process.env['PI_RESEARCH_MOCK_SEARCH'] = savedMockSearch;
        else delete process.env['PI_RESEARCH_MOCK_SEARCH'];
        if (savedMockScrape !== undefined) process.env['PI_RESEARCH_MOCK_SCRAPE'] = savedMockScrape;
        else delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
      }

      // headless:true on Wayland needs no Xvfb — the check must be skipped entirely.
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalledWith('which', ['Xvfb'], expect.anything());
      expect(result.healthy).toBe(true);
    });

    it('(D) returns unhealthy with browser-missing message when binary is absent (non-Linux path)', async (ctx) => {
      // This test exercises the `else` branch (isBrowserAvailable() returns false).
      // We simulate it by forcing FULL_MOCK_MODE=false AND having no binary.
      // Since we can't uninstall the binary, we test on a known-absent configuration
      // by checking the return value when the binary check logic would fail.
      //
      // This is explicitly not a Linux-only test; it validates the error message
      // that appears on any OS when the browser binary is absent.
      //
      // Skip if browser IS available (we can't test the "absent" path with it present).
      if (isBrowserAvailable()) return ctx.skip();

      delete process.env['PI_RESEARCH_MOCK_SEARCH'];
      delete process.env['PI_RESEARCH_MOCK_SCRAPE'];

      const result = await checkBrowserCapability();

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('npm run setup');
    });
  });

  // =========================================================================
  // Group 4: Wayland-specific scenario validation
  //
  // On a Wayland-native desktop (no XWayland), DISPLAY is absent but
  // WAYLAND_DISPLAY is set. headless:true works natively — Firefox can use
  // the Wayland display protocol directly without any X11 socket.
  //
  // headless:'virtual' is NOT used on pure Wayland. The JS camoufox port
  // injects DISPLAY (the Xvfb display) but does NOT strip WAYLAND_DISPLAY,
  // GDK_BACKEND, or MOZ_ENABLE_WAYLAND (unlike the Python port). Firefox may
  // therefore ignore the injected DISPLAY and connect to the Wayland compositor
  // instead of Xvfb, making the mode unreliable.
  // =========================================================================

  describe('Wayland-without-XWayland scenario', () => {
    it('resolveHeadlessMode returns true when only WAYLAND_DISPLAY is set (pure Wayland)', (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();

      delete process.env['DISPLAY'];
      process.env['WAYLAND_DISPLAY'] = 'wayland-1';

      // headless:true works natively on Wayland; headless:'virtual' is avoided because
      // the JS camoufox port does not strip WAYLAND_DISPLAY before spawning Xvfb.
      expect(resolveHeadlessMode()).toBe(true);
    });

    it('resolveHeadlessMode returns true when XWayland bridges Wayland to X11', (ctx) => {
      if (process.platform !== 'linux') return ctx.skip();

      // XWayland sets DISPLAY (e.g. :0) even on a Wayland compositor.
      process.env['DISPLAY'] = ':0';
      process.env['WAYLAND_DISPLAY'] = 'wayland-0';

      // Standard headless works because an X11 socket is available.
      expect(resolveHeadlessMode()).toBe(true);
    });
  });
});
