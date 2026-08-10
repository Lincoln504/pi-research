/**
 * Regression: the general scrape path launches a REAL Camoufox/Firefox
 * browser (unlike the dedicated `youtube_transcript` tool, which only makes
 * API-style calls via youtubei.js/jsdom and never touches the browser). If a
 * researcher scrapes a youtube.com watch-page URL through the ordinary
 * `scrape` tool, YouTube autoplays video with sound — and without an
 * explicit engine-level mute, that plays audible audio through the host
 * machine's speakers. Reported on Linux (both true headless and the
 * Xvfb-backed 'virtual' mode keep a real PulseAudio/PipeWire/ALSA sink
 * reachable), but headless Firefox is not guaranteed silent on macOS/Windows
 * either, so the mute must be unconditional across platforms.
 *
 * initBrowser() must pass `firefox_user_prefs['media.volume_scale'] = '0.0'`
 * (the standard headless-Firefox audio kill switch — it forces output volume
 * to zero regardless of per-tab mute/autoplay state) on every launch, on
 * every platform and headless mode, without altering rendering behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCamoufox = vi.fn();
vi.mock('camoufox-js', () => ({
  Camoufox: mockCamoufox,
}));

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, platform: vi.fn().mockImplementation(real.platform) };
});

import * as nodeOs from 'node:os';
import { initBrowser, resetBrowser } from '../../../src/infrastructure/browser/thread-worker-browser.ts';

const platformSpy = vi.mocked(nodeOs.platform);

function fakeBrowser() {
  return {
    isConnected: () => true,
    newContext: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('initBrowser() mutes audio at the Camoufox launch-options level', () => {
  beforeEach(() => {
    resetBrowser();
    vi.clearAllMocks();
    // Pin to a non-Windows platform so the win32 headed-launch fallback never
    // re-invokes the single-shot mock below.
    platformSpy.mockReturnValue('linux');
  });

  it('passes media.volume_scale: "0.0" in firefox_user_prefs on every launch', async () => {
    mockCamoufox.mockResolvedValueOnce(fakeBrowser());

    await initBrowser();

    expect(mockCamoufox).toHaveBeenCalledTimes(1);
    const opts = mockCamoufox.mock.calls[0]?.[0];
    expect(opts.firefox_user_prefs).toMatchObject({
      'media.volume_scale': '0.0',
    });
  });

  it('also blocks autoplay outright (belt-and-suspenders alongside the volume mute)', async () => {
    mockCamoufox.mockResolvedValueOnce(fakeBrowser());

    await initBrowser();

    const opts = mockCamoufox.mock.calls[0]?.[0];
    expect(opts.firefox_user_prefs).toMatchObject({
      'media.autoplay.default': 5,
    });
  });

  it('does not disable rendering/video display — only audio prefs are set, headless mode is unaffected', async () => {
    mockCamoufox.mockResolvedValueOnce(fakeBrowser());

    await initBrowser();

    const opts = mockCamoufox.mock.calls[0]?.[0];
    // The mute must not be implemented by e.g. flipping headless or blocking
    // media/video loading outright — those would break legitimate page
    // rendering. Only the audio-specific prefs should be present.
    expect(opts.firefox_user_prefs).not.toHaveProperty('media.block_play');
    expect(opts).toHaveProperty('headless');
  });

  it('applies the mute on the Windows headed-launch fallback retry too', async () => {
    platformSpy.mockReturnValue('win32');
    mockCamoufox
      .mockRejectedValueOnce(new Error('Browser closed (STATUS_BREAKPOINT 0x80000003)'))
      .mockResolvedValueOnce(fakeBrowser());

    await initBrowser();

    expect(mockCamoufox).toHaveBeenCalledTimes(2);
    for (const call of mockCamoufox.mock.calls) {
      expect((call[0] as any).firefox_user_prefs).toMatchObject({
        'media.volume_scale': '0.0',
      });
    }
  });
});
