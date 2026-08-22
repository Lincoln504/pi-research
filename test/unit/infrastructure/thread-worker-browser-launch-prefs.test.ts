/**
 * Regression pin: the browser launch options must keep the engine-level
 * WebSocket disable.
 *
 * WebSocket connections bypass BOTH layers of the browser scrape SSRF defense:
 * page.route('**') intercepts HTTP(S) only, and the serverAddr() rebinding
 * backstop hangs off page.on('response'), which a WS handshake never fires. A
 * hostile scraped page could therefore `new WebSocket('ws://10.x.x.x/...')` to
 * probe or reach internal hosts with no validation and write the reply into the
 * DOM that page.content() returns. `network.websocket.max-connections: 0`
 * closes that channel outright; a firefox_user_prefs refactor must not drop it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('camoufox-js', () => ({
  Camoufox: vi.fn(async () => ({
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => ({
      close: vi.fn(async () => {}),
      route: vi.fn(async () => {}),
    })),
    close: vi.fn(async () => {}),
  })),
}));

import { Camoufox } from 'camoufox-js';

describe('thread-worker-browser — launch prefs close the WebSocket SSRF channel', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(Camoufox).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('launches with network.websocket.max-connections: 0 in firefox_user_prefs', async () => {
    const { initBrowser } = await import('../../../src/infrastructure/browser/thread-worker-browser.ts');
    await initBrowser();

    expect(vi.mocked(Camoufox)).toHaveBeenCalledTimes(1);
    const launchOptions = vi.mocked(Camoufox).mock.calls[0]![0] as {
      firefox_user_prefs?: Record<string, unknown>;
    };
    expect(launchOptions.firefox_user_prefs).toBeDefined();
    // Exactly 0 (not merely falsy/absent): the value is the whole defense.
    expect(launchOptions.firefox_user_prefs!['network.websocket.max-connections']).toBe(0);
  });
});
