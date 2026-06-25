/**
 * Unit tests for the youtube_transcript tool wrapper.
 *
 * The backend command is mocked; these tests cover the wrapper's contract:
 * rate limiting (one call per researcher), parameter validation, delegation,
 * and error wrapping (it must never throw to the agent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const youtubeTranscriptCommand = vi.fn();
vi.mock('../../../src/youtube/index.ts', () => ({
  youtubeTranscriptCommand: (...args: unknown[]) => youtubeTranscriptCommand(...args),
}));

import { createYoutubeTranscriptTool } from '../../../src/tools/youtube-transcript.ts';
import { ToolUsageTracker, createDefaultToolLimits } from '../../../src/utils/tool-usage-tracker.ts';

const ctx = { cwd: '/tmp' } as any;
const okResult = { content: [{ type: 'text', text: '# YouTube Transcripts' }], details: { fetched: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  youtubeTranscriptCommand.mockResolvedValue(okResult);
});

describe('tools/youtube-transcript', () => {
  it('creates a tool named youtube_transcript', () => {
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()) });
    expect(tool.name).toBe('youtube_transcript');
    expect(tool.executionMode).toBe('parallel');
  });

  it('records the call against the tracker', async () => {
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    const spy = vi.spyOn(tracker, 'recordCall');
    const tool = createYoutubeTranscriptTool({ ctx, tracker });

    await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);

    expect(spy).toHaveBeenCalledWith('youtube_transcript');
    expect(youtubeTranscriptCommand).toHaveBeenCalledOnce();
  });

  it('enforces one call per researcher (second call is blocked)', async () => {
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    const tool = createYoutubeTranscriptTool({ ctx, tracker });

    const first = await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);
    const second = await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);

    expect((first as any).details.fetched).toBe(1);
    expect((second as any).details).toMatchObject({ blocked: true, reason: 'limit_reached' });
    expect((second as any).content[0].text).toMatch(/YOUTUBE TRANSCRIPT LIMIT REACHED/);
    // The backend ran exactly once.
    expect(youtubeTranscriptCommand).toHaveBeenCalledOnce();
  });

  it('rejects invalid parameters without calling the backend', async () => {
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()) });

    const res = await tool.execute('id', { urls: 'not-an-array' } as any, undefined, undefined as any, ctx);

    expect((res as any).details.error).toBe('invalid_params');
    expect(youtubeTranscriptCommand).not.toHaveBeenCalled();
  });

  it('rejects an empty url list', async () => {
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()) });
    const res = await tool.execute('id', { urls: ['   '] }, undefined, undefined as any, ctx);
    expect((res as any).details.error).toBe('no_urls');
    expect(youtubeTranscriptCommand).not.toHaveBeenCalled();
  });

  it('caps urls to the configured max (maxItems schema)', async () => {
    const config = { YOUTUBE_TRANSCRIPT_MAX_VIDEOS: 2, YOUTUBE_TRANSCRIPT_TIMEOUT_MS: 20000, YOUTUBE_TRANSCRIPT_LANG: 'en' } as any;
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()), config });

    const res = await tool.execute(
      'id',
      { urls: ['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb', 'https://youtu.be/ccccccccccc'] },
      undefined,
      undefined as any,
      ctx,
    );

    // 3 urls exceeds maxItems=2 → schema rejects.
    expect((res as any).details.error).toBe('invalid_params');
  });

  it('wraps backend errors into a tool result instead of throwing', async () => {
    youtubeTranscriptCommand.mockRejectedValueOnce(new Error('boom'));
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()) });

    const res = await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);

    expect((res as any).details.error).toBe('boom');
    expect((res as any).content[0].text).toMatch(/YouTube Transcript Failed/);
  });

  it('passes config-derived options through to the backend', async () => {
    const config = { YOUTUBE_TRANSCRIPT_MAX_VIDEOS: 3, YOUTUBE_TRANSCRIPT_TIMEOUT_MS: 12345, YOUTUBE_TRANSCRIPT_LANG: 'de' } as any;
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()), config });

    await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);

    expect(youtubeTranscriptCommand).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 12345, lang: 'de', maxVideos: 3 }),
    );
  });
});
