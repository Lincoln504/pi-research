/**
 * Unit Tests: resolveHeadlessMode() — platform and display-environment branching
 *
 * Integration tests can only exercise branches reachable on the current host OS.
 * These tests mock node:os.platform() to verify branching across all platforms
 * (win32, darwin, linux) and all display-environment states (DISPLAY, WAYLAND_DISPLAY)
 * without needing a Windows or macOS machine.
 *
 * Key contract being verified:
 *   win32  → true      (true headless; camoufox-js >=0.10 fixed the old crash, no visible window)
 *   darwin → true      (native headless works on macOS)
 *   linux + DISPLAY    → true   (X11 or XWayland present)
 *   linux + WAYLAND_DISPLAY only → true  (pure Wayland; JS port doesn't strip WAYLAND_DISPLAY)
 *   linux + DISPLAY + WAYLAND_DISPLAY → true  (XWayland active)
 *   linux + nothing    → true  (TTY: true headless, renders offscreen, no Xvfb)
 *   linux + nothing + PI_RESEARCH_USE_XVFB=true → 'virtual'  (explicit Xvfb opt-in)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock node:os so we can simulate win32 / darwin without running on those platforms.
// vi.mock is hoisted above all imports, so config.ts's `platform` binding receives
// the mock function when the module is first evaluated.
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, platform: vi.fn().mockImplementation(real.platform) };
});

import * as nodeOs from 'node:os';
import { resolveHeadlessMode } from '../../../src/infrastructure/browser/config.ts';

const platformSpy = vi.mocked(nodeOs.platform);

describe('resolveHeadlessMode() — platform and display-environment branching', () => {
  const savedDisplay = process.env['DISPLAY'];
  const savedWayland = process.env['WAYLAND_DISPLAY'];
  const savedUseXvfb = process.env['PI_RESEARCH_USE_XVFB'];

  afterEach(() => {
    platformSpy.mockClear();
    if (savedDisplay !== undefined) process.env['DISPLAY'] = savedDisplay;
    else delete process.env['DISPLAY'];
    if (savedWayland !== undefined) process.env['WAYLAND_DISPLAY'] = savedWayland;
    else delete process.env['WAYLAND_DISPLAY'];
    if (savedUseXvfb !== undefined) process.env['PI_RESEARCH_USE_XVFB'] = savedUseXvfb;
    else delete process.env['PI_RESEARCH_USE_XVFB'];
  });

  it('returns true on Windows — true headless, no visible window (camoufox-js >=0.10 fixed the old crash)', () => {
    platformSpy.mockReturnValueOnce('win32');
    expect(resolveHeadlessMode()).toBe(true);
  });

  it('returns true on macOS — native headless works correctly', () => {
    platformSpy.mockReturnValueOnce('darwin');
    expect(resolveHeadlessMode()).toBe(true);
  });

  it('returns true on Linux with DISPLAY set (X11 or XWayland)', () => {
    platformSpy.mockReturnValueOnce('linux');
    delete process.env['WAYLAND_DISPLAY'];
    process.env['DISPLAY'] = ':0';
    expect(resolveHeadlessMode()).toBe(true);
  });

  it('returns true on Linux with only WAYLAND_DISPLAY (pure Wayland, no XWayland)', () => {
    // The JS camoufox port does not strip WAYLAND_DISPLAY before spawning Xvfb.
    // Firefox on a pure Wayland host may connect to the Wayland compositor instead of Xvfb,
    // making headless:'virtual' unreliable. headless:true works natively on Wayland.
    platformSpy.mockReturnValueOnce('linux');
    delete process.env['DISPLAY'];
    process.env['WAYLAND_DISPLAY'] = 'wayland-0';
    expect(resolveHeadlessMode()).toBe(true);
  });

  it('returns true on Linux with both DISPLAY and WAYLAND_DISPLAY (XWayland active)', () => {
    platformSpy.mockReturnValueOnce('linux');
    process.env['DISPLAY'] = ':0';
    process.env['WAYLAND_DISPLAY'] = 'wayland-0';
    expect(resolveHeadlessMode()).toBe(true);
  });

  it('returns true on Linux TTY by default (no DISPLAY/WAYLAND, no Xvfb opt-in) — true headless needs no Xvfb', () => {
    platformSpy.mockReturnValueOnce('linux');
    delete process.env['DISPLAY'];
    delete process.env['WAYLAND_DISPLAY'];
    delete process.env['PI_RESEARCH_USE_XVFB'];
    expect(resolveHeadlessMode()).toBe(true);
  });

  it('returns "virtual" on Linux TTY only when PI_RESEARCH_USE_XVFB=true (explicit Xvfb opt-in)', () => {
    platformSpy.mockReturnValueOnce('linux');
    delete process.env['DISPLAY'];
    delete process.env['WAYLAND_DISPLAY'];
    process.env['PI_RESEARCH_USE_XVFB'] = 'true';
    expect(resolveHeadlessMode()).toBe('virtual');
  });

  it('Xvfb opt-in is ignored when a real display is present (DISPLAY wins → true)', () => {
    platformSpy.mockReturnValueOnce('linux');
    process.env['DISPLAY'] = ':0';
    delete process.env['WAYLAND_DISPLAY'];
    process.env['PI_RESEARCH_USE_XVFB'] = 'true';
    expect(resolveHeadlessMode()).toBe(true);
  });

  it('is not cached — reads process.env on every call', () => {
    platformSpy.mockReturnValue('linux');
    delete process.env['PI_RESEARCH_USE_XVFB'];

    process.env['DISPLAY'] = ':99';
    delete process.env['WAYLAND_DISPLAY'];
    expect(resolveHeadlessMode()).toBe(true);

    delete process.env['DISPLAY'];
    expect(resolveHeadlessMode()).toBe(true);

    process.env['PI_RESEARCH_USE_XVFB'] = 'true';
    expect(resolveHeadlessMode()).toBe('virtual');

    process.env['WAYLAND_DISPLAY'] = 'wayland-0';
    expect(resolveHeadlessMode()).toBe(true);

    platformSpy.mockRestore();
  });
});
