/**
 * Unit tests for the YouTube transcript client.
 *
 * youtubei.js, the PoToken minter, and global fetch are all mocked so these
 * tests are deterministic and offline. They exercise the parts that matter for
 * correctness: the empty-body guard (the 2026 silent-failure trap), caption
 * selection, graceful degradation when minting fails, and per-video isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mintPoTokens = vi.fn();
const innertubeCreate = vi.fn();

vi.mock('youtubei.js', () => ({
  Innertube: { create: (...args: unknown[]) => innertubeCreate(...args) },
}));
vi.mock('../../../src/youtube/potoken.ts', () => ({
  mintPoTokens: (...args: unknown[]) => mintPoTokens(...args),
  DEFAULT_REQUEST_KEY: 'test-key',
}));

import { fetchVideoTranscripts } from '../../../src/youtube/transcript-client.ts';

const VISITOR = 'VISITOR_DATA';

function json3(...phrases: string[]): string {
  return JSON.stringify({ events: phrases.map((p) => ({ segs: [{ utf8: p }] })) });
}

/** A mock fetch returning a json3 body (or empty body) for timedtext requests. */
function mockFetch(body: string, status = 200): typeof fetch {
  return vi.fn(async () => ({ status, text: async () => body })) as unknown as typeof fetch;
}

function seedSession() {
  return { session: { context: { client: { visitorData: VISITOR } } } };
}

function realSession(getInfo: ReturnType<typeof vi.fn>) {
  return { getInfo };
}

function infoWith(tracks: Array<{ base_url: string; language_code?: string; kind?: string }>, basic = {}) {
  return { basic_info: basic, captions: { caption_tracks: tracks } };
}

const TRACK = { base_url: 'https://yt.example/timedtext?v=1', language_code: 'en' };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: minting succeeds with a session token + a token per requested video.
  mintPoTokens.mockImplementation(async (identifiers: string[]) => {
    const m = new Map<string, string>();
    for (const id of identifiers) m.set(id, `tok-${id}`);
    return m;
  });
});

describe('youtube/transcript-client', () => {
  it('returns a parsed transcript on the happy path', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK], { title: 'Hello', author: 'Chan', duration: 65 }));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch(json3('hello ', 'world')));

    const [res] = await fetchVideoTranscripts(['vid00000001']);

    expect(res.success).toBe(true);
    expect(res.text).toBe('hello world');
    expect(res.title).toBe('Hello');
    expect(res.author).toBe('Chan');
    expect(res.durationSeconds).toBe(65);
    expect(res.lang).toBe('en');
    expect(res.charCount).toBe('hello world'.length);
    vi.unstubAllGlobals();
  });

  it('treats an HTTP-200 empty body as a failure, never a blank success', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch('', 200)); // the silent-failure trap

    const [res] = await fetchVideoTranscripts(['vid00000001']);

    expect(res.success).toBe(false);
    expect(res.text).toBeUndefined();
    expect(res.error).toMatch(/empty|bot-protection/i);
    vi.unstubAllGlobals();
  });

  it('reports videos with no caption tracks as unavailable', async () => {
    const getInfo = vi.fn(async () => infoWith([])); // no captions
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch(json3('unused')));

    const [res] = await fetchVideoTranscripts(['vid00000001']);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no captions|transcript available/i);
    vi.unstubAllGlobals();
  });

  it('degrades gracefully when PoToken minting fails (every video unavailable, real reason)', async () => {
    mintPoTokens.mockRejectedValueOnce(new Error('attestation rejected'));
    innertubeCreate.mockResolvedValueOnce(seedSession());
    vi.stubGlobal('fetch', mockFetch(json3('x')));

    const results = await fetchVideoTranscripts(['vid00000001', 'vid00000002']);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.success)).toBe(true);
    expect(results[0]!.error).toMatch(/token unavailable|residential/i);
    vi.unstubAllGlobals();
  });

  it('isolates per-video failures — one bad video does not sink the batch', async () => {
    const getInfo = vi.fn(async (id: string) => {
      if (id === 'vid00000002') throw new Error('This video is unavailable');
      return infoWith([TRACK], { title: `T-${id}` });
    });
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch(json3('ok')));

    const results = await fetchVideoTranscripts(['vid00000001', 'vid00000002', 'vid00000003']);

    const byId = Object.fromEntries(results.map((r) => [r.videoId, r]));
    expect(byId['vid00000001']!.success).toBe(true);
    expect(byId['vid00000002']!.success).toBe(false);
    expect(byId['vid00000003']!.success).toBe(true);
    vi.unstubAllGlobals();
  });

  it('selects the requested language track when multiple are present', async () => {
    const tracks = [
      { base_url: 'https://yt.example/de', language_code: 'de' },
      { base_url: 'https://yt.example/en', language_code: 'en' },
    ];
    const getInfo = vi.fn(async () => infoWith(tracks));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    const fetchSpy = mockFetch(json3('hi'));
    vi.stubGlobal('fetch', fetchSpy);

    const [res] = await fetchVideoTranscripts(['vid00000001'], { lang: 'en' });

    expect(res.success).toBe(true);
    expect(res.lang).toBe('en');
    // The English base_url must be the one fetched.
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('/en');
    vi.unstubAllGlobals();
  });

  it('fires onVideoComplete for each video', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch(json3('hi')));
    const onVideoComplete = vi.fn();

    await fetchVideoTranscripts(['vid00000001'], { onVideoComplete });

    expect(onVideoComplete).toHaveBeenCalledWith('vid00000001', true);
    vi.unstubAllGlobals();
  });

  it('returns [] for an empty id list without touching the network', async () => {
    const results = await fetchVideoTranscripts([]);
    expect(results).toEqual([]);
    expect(innertubeCreate).not.toHaveBeenCalled();
  });
});
