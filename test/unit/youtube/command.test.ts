/**
 * Unit tests for youtubeTranscriptCommand (extraction + formatting + details).
 * The transcript client is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchVideoTranscripts = vi.fn();
vi.mock('../../../src/youtube/transcript-client.ts', () => ({
  fetchVideoTranscripts: (...args: unknown[]) => fetchVideoTranscripts(...args),
}));

import { youtubeTranscriptCommand } from '../../../src/youtube/index.ts';

beforeEach(() => vi.clearAllMocks());

describe('youtube/command', () => {
  it('returns a no-videos message when no valid YouTube links are given', async () => {
    const res = await youtubeTranscriptCommand({
      urls: ['https://example.com/post', 'garbage'],
      maxVideos: 3,
      timeoutMs: 20000,
      lang: 'en',
    });

    expect(res.details).toMatchObject({ requested: 0, fetched: 0, rejected: 2 });
    expect((res.content[0] as any).text).toMatch(/No valid YouTube video links/);
    expect(fetchVideoTranscripts).not.toHaveBeenCalled();
  });

  it('extracts IDs, caps to maxVideos, and forwards them to the client', async () => {
    fetchVideoTranscripts.mockResolvedValueOnce([
      { videoId: 'aaaaaaaaaaa', url: 'u', success: true, title: 'A', text: 'alpha', charCount: 5, lang: 'en' },
    ]);

    const res = await youtubeTranscriptCommand({
      urls: [
        'https://youtu.be/aaaaaaaaaaa',
        'https://www.youtube.com/watch?v=bbbbbbbbbbb',
        'https://www.youtube.com/watch?v=ccccccccccc',
      ],
      maxVideos: 1,
      timeoutMs: 20000,
      lang: 'en',
    });

    const call = fetchVideoTranscripts.mock.calls[0]!;
    expect(call[0]).toEqual(['aaaaaaaaaaa']); // capped to 1
    expect(res.details.requested).toBe(1);
    expect(res.details.fetched).toBe(1);
  });

  it('formats successes and failures into distinct sections', async () => {
    fetchVideoTranscripts.mockResolvedValueOnce([
      { videoId: 'aaaaaaaaaaa', url: 'https://youtu.be/aaaaaaaaaaa', success: true, title: 'Good', author: 'Chan', durationSeconds: 65, lang: 'en', text: 'transcript text', charCount: 15 },
      { videoId: 'bbbbbbbbbbb', url: 'https://youtu.be/bbbbbbbbbbb', success: false, error: 'No captions/transcript available for this video.' },
    ]);

    const res = await youtubeTranscriptCommand({
      urls: ['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'],
      maxVideos: 3,
      timeoutMs: 20000,
      lang: 'en',
    });

    const text = (res.content[0] as any).text as string;
    expect(text).toContain('YouTube Transcripts (1 of 2 retrieved)');
    expect(text).toContain('## aaaaaaaaaaa: Good');
    expect(text).toContain('Channel: Chan');
    expect(text).toContain('Duration: 1:05');
    expect(text).toContain('transcript text');
    // The Cite-as line must LEAD with the watch URL: a title-only citation is
    // invisible to the synthesis citation pipeline (URLs are what it extracts),
    // which silently drops the transcript's provenance from the final report.
    expect(text).toContain("**Cite as:** https://youtu.be/aaaaaaaaaaa — 'Good' by Chan");
    expect(text).toContain('## Unavailable (1)');
    expect(text).toContain('No captions/transcript available');
    expect(res.details).toMatchObject({ requested: 2, fetched: 1, failed: 1 });
  });

  it('still emits a parseable "Cite as" line for a video with no title (regression: used to be dropped entirely)', async () => {
    fetchVideoTranscripts.mockResolvedValueOnce([
      { videoId: 'aaaaaaaaaaa', url: 'https://youtu.be/aaaaaaaaaaa', success: true, text: 'transcript text', charCount: 15 },
    ]);

    const res = await youtubeTranscriptCommand({
      urls: ['https://youtu.be/aaaaaaaaaaa'],
      maxVideos: 1,
      timeoutMs: 20000,
      lang: 'en',
    });

    const text = (res.content[0] as any).text as string;
    expect(text).toContain('**Cite as:** https://youtu.be/aaaaaaaaaaa');
    // No title/author suffix should be appended when neither is known.
    expect(text).not.toContain("**Cite as:** https://youtu.be/aaaaaaaaaaa —");
  });

  it('emits a knowledge-store document only for successful transcripts', async () => {
    fetchVideoTranscripts.mockResolvedValueOnce([
      { videoId: 'aaaaaaaaaaa', url: 'https://youtu.be/aaaaaaaaaaa', success: true, title: 'Good Video', author: 'Chan', durationSeconds: 65, text: 'the full transcript', charCount: 19 },
      { videoId: 'bbbbbbbbbbb', url: 'https://youtu.be/bbbbbbbbbbb', success: false, error: 'no captions' },
    ]);
    const docs: Array<{ url: string; document: string }> = [];

    await youtubeTranscriptCommand({
      urls: ['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'],
      maxVideos: 3,
      timeoutMs: 20000,
      lang: 'en',
      onTranscriptDocument: (url, document) => docs.push({ url, document }),
    });

    expect(docs).toHaveLength(1); // only the successful video
    expect(docs[0]!.url).toBe('https://youtu.be/aaaaaaaaaaa');
    expect(docs[0]!.document).toContain('# Good Video');
    expect(docs[0]!.document).toContain('Channel: Chan');
    expect(docs[0]!.document).toContain('the full transcript');
  });

  it('notes skipped non-YouTube links in the output', async () => {
    fetchVideoTranscripts.mockResolvedValueOnce([
      { videoId: 'aaaaaaaaaaa', url: 'https://youtu.be/aaaaaaaaaaa', success: true, text: 'x', charCount: 1 },
    ]);

    const res = await youtubeTranscriptCommand({
      urls: ['https://youtu.be/aaaaaaaaaaa', 'https://example.com/not-youtube'],
      maxVideos: 3,
      timeoutMs: 20000,
      lang: 'en',
    });

    expect((res.content[0] as any).text).toMatch(/Skipped 1 non-YouTube link/);
    expect(res.details.rejected).toBe(1);
  });
});
