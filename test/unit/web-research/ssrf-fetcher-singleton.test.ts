/**
 * The SSRF-safe fetcher must be a real singleton, and must be disposable.
 *
 * The cache used to hold the RESOLVED value, assigned only after
 * `await import('undici')`. Concurrent first callers therefore all passed the
 * `undefined` check, each constructed its own `Agent`, and only the last
 * assignment survived in the cache — handing every other caller a live Agent
 * that nothing tracked. Those Agents opened keep-alive sockets that no shutdown
 * path could close, which is exactly the leak disposeSsrfSafeFetcher exists to
 * prevent. Scrapes run concurrently by design, so the first burst hit this.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getSsrfSafeFetcher, disposeSsrfSafeFetcher } from '../../../src/web-research/scraper-utils.ts';

afterEach(async () => {
  // Leave no Agent behind for the next test file in this worker.
  await disposeSsrfSafeFetcher();
});

describe('getSsrfSafeFetcher singleton', () => {
  it('hands every concurrent first caller the SAME fetcher', async () => {
    const [a, b, c] = await Promise.all([
      getSsrfSafeFetcher(),
      getSsrfSafeFetcher(),
      getSsrfSafeFetcher(),
    ]);
    expect(a).not.toBeNull();
    // Identity, not deep equality: two distinct Agents would compare equal
    // structurally while being two separate socket pools.
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect((b as { dispatcher: unknown }).dispatcher).toBe((a as { dispatcher: unknown }).dispatcher);
  });

  it('rebuilds after disposal rather than returning a closed Agent', async () => {
    // The SDK can be re-initialized in the same process (the pi extension host
    // survives init/shutdown cycles), so the cache must clear on dispose — a
    // closed Agent left behind would fail every subsequent scrape.
    const first = await getSsrfSafeFetcher();
    await disposeSsrfSafeFetcher();
    const second = await getSsrfSafeFetcher();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('disposes an Agent whose construction was still in flight', async () => {
    // dispose racing the very first call must not orphan the Agent that call is
    // still building. Nothing is awaited between these two lines on purpose.
    const inFlight = getSsrfSafeFetcher();
    await disposeSsrfSafeFetcher();
    const built = await inFlight;
    expect(built).not.toBeNull();
    // The raced construction settled, and the cache is empty — so the next
    // caller builds a fresh one rather than reusing the disposed instance.
    const next = await getSsrfSafeFetcher();
    expect(next).not.toBe(built);
  });
});
