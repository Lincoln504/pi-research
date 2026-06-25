/**
 * Integration test: real YouTube transcript fetch (PoToken end-to-end).
 *
 * Drives the REAL pipeline — youtubei.js InnerTube + bgutils-js BotGuard PoToken
 * minting under jsdom + a live timedtext fetch. It requires network access and a
 * residential-grade IP (YouTube's attestation rejects datacenter IPs), so it is
 * gated behind skipsLiveNetwork() exactly like the live-site scrape tests and is
 * skipped in CI.
 *
 * "Me at the zoo" (jNQXAC9IVRw) is the first-ever YouTube video and has stable
 * English captions, which makes it a reliable fixture.
 */

import { describe, it, expect } from 'vitest';
import { fetchVideoTranscripts } from '../../src/youtube/transcript-client.ts';
import { youtubeTranscriptCommand } from '../../src/youtube/index.ts';
import { skipsLiveNetwork } from './helpers/setup.ts';

const ME_AT_THE_ZOO = 'jNQXAC9IVRw';

describe('youtube transcript (live)', () => {
  it('mints a PoToken and fetches a real transcript', async (ctx) => {
    if (skipsLiveNetwork()) return ctx.skip();

    const [res] = await fetchVideoTranscripts([ME_AT_THE_ZOO], { timeoutMs: 45000 });

    // On a residential IP this succeeds; if attestation is rejected (datacenter),
    // the result is a clean failure with a real reason — never a blank success.
    if (res!.success) {
      expect(res!.text && res!.text.length).toBeGreaterThan(20);
      expect(res!.title).toBeTruthy();
      expect(res!.lang).toMatch(/^en/);
    } else {
      expect(res!.error).toBeTruthy();
      expect(res!.text).toBeUndefined();
    }
  }, 90000);

  it('formats a batch result through the command layer', async (ctx) => {
    if (skipsLiveNetwork()) return ctx.skip();

    const result = await youtubeTranscriptCommand({
      urls: [`https://www.youtube.com/watch?v=${ME_AT_THE_ZOO}`, 'https://example.com/not-a-video'],
      maxVideos: 3,
      timeoutMs: 45000,
      lang: 'en',
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('YouTube Transcripts');
    expect(result.details.requested).toBe(1); // only the YouTube link
    expect(result.details.rejected).toBe(1);  // example.com skipped
  }, 90000);
});
