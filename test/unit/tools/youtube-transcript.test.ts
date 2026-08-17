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

const cacheScrapedContent = vi.fn();
const registerScrapedLinks = vi.fn();
const registerTranscribedLinks = vi.fn();
const registerResearcherScrapes = vi.fn();
vi.mock('../../../src/utils/shared-links.ts', () => ({
  cacheScrapedContent: (...a: unknown[]) => cacheScrapedContent(...a),
  registerScrapedLinks: (...a: unknown[]) => registerScrapedLinks(...a),
  registerTranscribedLinks: (...a: unknown[]) => registerTranscribedLinks(...a),
  registerResearcherScrapes: (...a: unknown[]) => registerResearcherScrapes(...a),
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

  it('does not spend the researcher\'s only call on a request it refused', async () => {
    // The budget was recorded BEFORE validation, so a researcher passing one URL too
    // many (the schema caps the array; the allowance is a single call) got a validation
    // error and lost its only call — and the retry was then told "You have already used
    // your one youtube_transcript call", which was false. The round lost transcripts
    // entirely, for a mistake the researcher could have corrected.
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    const tool = createYoutubeTranscriptTool({ ctx, tracker });

    const rejected = await tool.execute('id', { urls: 'not-an-array' } as any, undefined, undefined as any, ctx);
    expect((rejected as any).details.error).toBe('invalid_params');

    // The corrected retry must still be served.
    const retry = await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);
    expect((retry as any).details.fetched).toBe(1);
    expect(youtubeTranscriptCommand).toHaveBeenCalledOnce();
  });

  it('does not spend it on an empty url list either', async () => {
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    const tool = createYoutubeTranscriptTool({ ctx, tracker });

    await tool.execute('id', { urls: ['   '] }, undefined, undefined as any, ctx);
    const retry = await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);

    expect((retry as any).details.fetched).toBe(1);
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

  it('ingests fetched transcripts into the session cache for knowledge-store pickup', async () => {
    // Make the mocked command invoke the ingestion callback like the real one.
    youtubeTranscriptCommand.mockImplementationOnce(async (opts: any) => {
      opts.onTranscriptDocument?.('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '# Title\n\ntranscript body');
      return okResult;
    });
    const tool = createYoutubeTranscriptTool({
      ctx,
      tracker: new ToolUsageTracker(createDefaultToolLimits()),
      getGlobalState: () => ({ researchId: 'res-123' }) as any,
      researcherId: '1.1',
      updateGlobalLinks: vi.fn(),
    });

    await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);

    expect(cacheScrapedContent).toHaveBeenCalledWith('res-123', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expect.stringContaining('transcript body'));
    expect(registerScrapedLinks).toHaveBeenCalledWith('res-123', ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
    // Provenance subset: the synthesis fallback labels these "YouTube Transcript".
    expect(registerTranscribedLinks).toHaveBeenCalledWith('res-123', ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
    expect(registerResearcherScrapes).toHaveBeenCalledWith('res-123', '1.1', ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  });

  it('does not cache when there is no research session (no knowledge-store context)', async () => {
    youtubeTranscriptCommand.mockImplementationOnce(async (opts: any) => {
      opts.onTranscriptDocument?.('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'doc');
      return okResult;
    });
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()) });

    await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);

    expect(cacheScrapedContent).not.toHaveBeenCalled();
  });

  it('wraps backend errors into a tool result instead of throwing', async () => {
    youtubeTranscriptCommand.mockRejectedValueOnce(new Error('boom'));
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()) });

    const res = await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, undefined, undefined as any, ctx);

    expect((res as any).details.error).toBe('boom');
    expect((res as any).content[0].text).toMatch(/YouTube Transcript Failed/);
  });

  it('propagates a cancellation instead of blaming YouTube bot-protection', async () => {
    // "never throws to the agent" is the right contract for a FAILURE and the wrong
    // one for a Ctrl-C. The failure text names network trouble and bot-protection —
    // neither of which happened — and then tells the agent to "continue with the rest
    // of your research", which is the opposite of what the user just asked for.
    const controller = new AbortController();
    youtubeTranscriptCommand.mockImplementationOnce(async () => {
      controller.abort();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()) });

    await expect(
      tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, controller.signal, undefined as any, ctx),
    ).rejects.toThrow(/aborted/i);
  });

  it('still wraps a genuine failure that happens to arrive while a signal exists', async () => {
    // The guard keys on the abort, not on the mere presence of a signal.
    const controller = new AbortController();
    youtubeTranscriptCommand.mockRejectedValueOnce(new Error('boom'));
    const tool = createYoutubeTranscriptTool({ ctx, tracker: new ToolUsageTracker(createDefaultToolLimits()) });

    const res = await tool.execute('id', { urls: ['https://youtu.be/dQw4w9WgXcQ'] }, controller.signal, undefined as any, ctx);

    expect((res as any).details.error).toBe('boom');
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
