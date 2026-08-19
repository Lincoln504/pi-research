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
  return vi.fn(async () => ({ status, ok: status >= 200 && status < 300, text: async () => body })) as unknown as typeof fetch;
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

const TRACK = { base_url: 'https://www.youtube.com/api/timedtext/timedtext?v=1', language_code: 'en' };

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

  it('rejects a timedtext redirect to an untrusted host instead of following it', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    const redirectFetch = vi.fn(async () => ({
      status: 302,
      ok: false,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://evil.example.com/steal' : null) },
      body: { cancel: async () => {} },
      text: async () => '',
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', redirectFetch);

    const [res] = await fetchVideoTranscripts(['vid00000001']);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not trusted/i);
    // The redirect must never be followed: exactly the first hop was fetched.
    expect(redirectFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('follows a timedtext redirect to another trusted Google host', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    const body = json3('hi ', 'there');
    const trustedRedirectFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://redirector.googlevideo.com/timedtext?x=1' : null) },
        body: { cancel: async () => {} },
        text: async () => '',
      })
      .mockResolvedValueOnce({ status: 200, ok: true, text: async () => body }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', trustedRedirectFetch);

    const [res] = await fetchVideoTranscripts(['vid00000001']);

    expect(res.success).toBe(true);
    expect(res.text).toBe('hi there');
    expect(trustedRedirectFetch).toHaveBeenCalledTimes(2);
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
      { base_url: 'https://www.youtube.com/api/timedtext/de', language_code: 'de' },
      { base_url: 'https://www.youtube.com/api/timedtext/en', language_code: 'en' },
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

  it('treats an unparseable (non-JSON) timedtext body as a failure', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch('<html>Bot check</html>'));
    const [res] = await fetchVideoTranscripts(['vid00000001']);
    expect(res.success).toBe(false);
    vi.unstubAllGlobals();
  });

  it('treats valid JSON without events as a failure', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch(JSON.stringify({ error: 'quota exceeded' })));
    const [res] = await fetchVideoTranscripts(['vid00000001']);
    expect(res.success).toBe(false);
    vi.unstubAllGlobals();
  });

  it('skips events that have no segs and still parses the rest', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    const body = JSON.stringify({ events: [{ tStartMs: 0 }, { segs: [{ utf8: 'hello' }, { utf8: ' world' }] }] });
    vi.stubGlobal('fetch', mockFetch(body));
    const [res] = await fetchVideoTranscripts(['vid00000001']);
    expect(res.success).toBe(true);
    expect(res.text).toBe('hello world');
    vi.unstubAllGlobals();
  });

  it('fails all videos when the seed session yields no visitor data', async () => {
    innertubeCreate.mockResolvedValueOnce({ session: { context: { client: {} } } });
    vi.stubGlobal('fetch', mockFetch(json3('x')));
    const results = await fetchVideoTranscripts(['vid00000001', 'vid00000002']);
    expect(results.every((r) => !r.success)).toBe(true);
    expect(results[0]!.error).toMatch(/visitor data/i);
    vi.unstubAllGlobals();
  });

  it('marks a video unavailable when the minter omitted its content token', async () => {
    // Minter returns the session token + a token for vid #1 only (partial map).
    mintPoTokens.mockImplementationOnce(async (ids: string[]) => {
      const m = new Map<string, string>();
      m.set(ids[0]!, `tok-${ids[0]}`); // visitorData
      m.set('vid00000001', 'tok-vid00000001');
      return m;
    });
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch(json3('ok')));

    const results = await fetchVideoTranscripts(['vid00000001', 'vid00000002']);
    const byId = Object.fromEntries(results.map((r) => [r.videoId, r]));
    expect(byId['vid00000001']!.success).toBe(true);
    expect(byId['vid00000002']!.success).toBe(false);
    expect(byId['vid00000002']!.error).toMatch(/content-bound token/i);
    vi.unstubAllGlobals();
  });

  it('does not reject when onVideoComplete throws (never-throws contract)', async () => {
    const getInfo = vi.fn(async () => infoWith([TRACK]));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch(json3('hi')));
    const results = await fetchVideoTranscripts(['vid00000001'], {
      onVideoComplete: () => { throw new Error('callback boom'); },
    });
    expect(results[0]!.success).toBe(true);
    vi.unstubAllGlobals();
  });

  it('falls back to a language-prefix track when no exact match exists', async () => {
    const tracks = [{ base_url: 'https://www.youtube.com/api/timedtext/enUS', language_code: 'en-US' }];
    const getInfo = vi.fn(async () => infoWith(tracks));
    innertubeCreate.mockResolvedValueOnce(seedSession()).mockResolvedValueOnce(realSession(getInfo));
    vi.stubGlobal('fetch', mockFetch(json3('hi')));
    const [res] = await fetchVideoTranscripts(['vid00000001'], { lang: 'en' });
    expect(res.success).toBe(true);
    expect(res.lang).toBe('en-US');
    vi.unstubAllGlobals();
  });
});
