/**
 * youtube_transcript Tool
 *
 * Fetches transcripts for YouTube videos the researcher selected from its link
 * pool. Used like the scrape tool: the agent picks which YouTube links to read,
 * and this tool reads up to a few of them in one batch.
 *
 * Constraints (enforced here):
 *  - One call per researcher (hard limit youtube_transcript: 1 in the tracker).
 *  - Up to YOUTUBE_TRANSCRIPT_MAX_VIDEOS (default 3) videos per call.
 *
 * Robustness comes from the backend (PoToken minting, empty-body guard, per-video
 * isolation, circuit breaker, timeouts); this wrapper handles validation, rate
 * limiting, metrics, and never throws to the agent.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { youtubeTranscriptCommand } from '../youtube/index.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { cacheScrapedContent, registerScrapedLinks, registerResearcherScrapes } from '../utils/shared-links.ts';
import { type Config, getConfig } from '../config.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';

export function createYoutubeTranscriptTool(options: {
  ctx: ExtensionContext;
  tracker?: ToolUsageTracker;
  /** Fires for each video as it completes (success or failure) — used for TUI flash. */
  onUrlScrapeResult?: (url: string, success: boolean) => void;
  /** Provides the research session id for knowledge-store ingestion of transcripts. */
  getGlobalState?: () => SystemResearchState;
  /** Registers transcribed URLs in the global pool (mirrors scrape). */
  updateGlobalLinks?: (links: string[]) => void;
  /** Researcher id for per-researcher source tracking. */
  researcherId?: string;
  config?: Config;
}): ToolDefinition {
  const { tracker } = options;
  const config = options.config || getConfig(options.ctx.cwd);
  const maxVideos = config.YOUTUBE_TRANSCRIPT_MAX_VIDEOS;

  const YoutubeParamsSchema = Type.Object({
    urls: Type.Array(
      Type.String({ description: 'YouTube watch/share/shorts/embed links (or bare 11-char video IDs)' }),
      { minItems: 1, maxItems: maxVideos, description: `Up to ${maxVideos} YouTube video links to transcribe` },
    ),
  });

  type YoutubeParams = Static<typeof YoutubeParamsSchema>;

  return {
    name: 'youtube_transcript',
    label: 'YouTube Transcripts',
    description:
      `Fetch the transcript (captions) of up to ${maxVideos} YouTube videos in one batch. ` +
      `Use it like the scrape tool, but for YouTube links from your search results: select the ` +
      `most relevant videos and read what they actually say. One call per researcher.`,
    promptSnippet: `Read transcripts of up to ${maxVideos} YouTube videos from your link pool (one call only)`,
    promptGuidelines: [
      `Select up to ${maxVideos} of the most relevant YouTube links from your search results — be judicious, exactly like choosing what to scrape.`,
      'You may call this tool only ONCE, so choose the videos carefully before calling.',
      'Pass full watch URLs, youtu.be links, or shorts/embed/live links. Non-YouTube links are ignored.',
      'Videos without captions, or that are private/age-restricted, are reported as unavailable — the rest still succeed.',
      "When you cite a YouTube source in CITED LINKS, use the video's ACTUAL title and channel (both shown in this tool's output) as the description — e.g. \"'<exact title>' by <channel>\". Do NOT paraphrase or invent a title; the watch URL alone is not human-identifiable.",
    ],
    parameters: YoutubeParamsSchema,
    executionMode: 'parallel',
    async execute(
      _callId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown>,
      extensionCtx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      // Rate-limit enforcement (one call per researcher).
      if (tracker) {
        const allowed = tracker.recordCall('youtube_transcript');
        if (!allowed) {
          metrics.increment('tool_youtube_transcript_calls_total', 1, { status: 'rate_limited' });
          return {
            content: [{ type: 'text', text: tracker.getLimitMessage('youtube_transcript') }],
            details: { blocked: true, reason: 'limit_reached' },
          };
        }
      }

      if (!Value.Check(YoutubeParamsSchema, params)) {
        metrics.increment('tool_youtube_transcript_calls_total', 1, { status: 'invalid_params' });
        return {
          content: [{ type: 'text', text: `Invalid parameters for youtube_transcript tool. Expected up to ${maxVideos} YouTube URLs.` }],
          details: { error: 'invalid_params' },
        };
      }

      const p = params as YoutubeParams;
      const urls = p.urls.map((u) => u.trim()).filter((u) => u.length > 0);
      if (urls.length === 0) {
        metrics.increment('tool_youtube_transcript_calls_total', 1, { status: 'no_urls' });
        return {
          content: [{ type: 'text', text: 'No YouTube links provided.' }],
          details: { error: 'no_urls' },
        };
      }

      // Resolve config against the live cwd for timeout/lang. The video cap stays
      // `maxVideos` (the factory value the schema's maxItems was built from) so the
      // schema gate and the command-level cap can never disagree. The PoToken
      // request key is intentionally not a tool parameter — it is read from the
      // env var by the minter (SDK callers may pass it through the command).
      const liveConfig = options.config || getConfig(extensionCtx.cwd);

      // Session id for knowledge-store ingestion: caching each transcript under
      // its watch URL lets the orchestrator's post-round writer pick it up as the
      // document `content` and embed the FULL transcript (gated by the writer
      // queue, i.e. only when the knowledge store is enabled). Also feeds in-run
      // dedup so a sibling never re-fetches the same video.
      const researchId = options.getGlobalState?.().researchId;
      const cachedUrls: string[] = [];

      try {
        const result = await youtubeTranscriptCommand({
          urls,
          maxVideos,
          timeoutMs: liveConfig.YOUTUBE_TRANSCRIPT_TIMEOUT_MS,
          lang: liveConfig.YOUTUBE_TRANSCRIPT_LANG,
          signal,
          onVideoComplete: (videoId, success) =>
            options.onUrlScrapeResult?.(`https://www.youtube.com/watch?v=${videoId}`, success),
          onTranscriptDocument: (url, document) => {
            if (researchId) {
              cacheScrapedContent(researchId, url, document);
              cachedUrls.push(url);
            }
          },
        });

        if (researchId && cachedUrls.length > 0) {
          registerScrapedLinks(researchId, cachedUrls);
          options.updateGlobalLinks?.(cachedUrls);
          if (options.researcherId) {
            registerResearcherScrapes(researchId, options.researcherId, cachedUrls);
          }
        }

        return result;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[youtube_transcript tool] Failed: ${errorMsg}`);
        metrics.increment('tool_youtube_transcript_calls_total', 1, { status: 'error' });
        return {
          content: [{
            type: 'text',
            text: `# YouTube Transcript Failed\n\n**Error:** ${errorMsg}\n\nThis may be due to network issues or YouTube bot-protection. Continue with the rest of your research.`,
          }],
          details: { error: errorMsg },
        };
      }
    },
  };
}
