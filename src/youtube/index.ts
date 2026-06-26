/**
 * YouTube transcript command
 *
 * Backend entry point for the `youtube_transcript` gathering tool. Turns the
 * YouTube links a researcher selected from its link pool into video IDs, fetches
 * up to `maxVideos` transcripts in a single batch, and formats them as markdown.
 */

import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { selectVideoIds } from './video-id.ts';
import { fetchVideoTranscripts, type VideoTranscript } from './transcript-client.ts';
import { metrics } from '../utils/metrics.ts';

export interface YoutubeTranscriptCommandOptions {
  urls: string[];
  maxVideos: number;
  timeoutMs: number;
  lang: string;
  requestKey?: string;
  signal?: AbortSignal;
  onVideoComplete?: (videoId: string, success: boolean) => void;
  /**
   * Called for each successfully-fetched transcript with a knowledge-store-ready
   * document (title/channel header + full transcript). The tool wires this to the
   * session scrape cache so the orchestrator ingests the full transcript text into
   * the knowledge store — exactly like a scraped page — when the store is enabled.
   */
  onTranscriptDocument?: (url: string, document: string) => void;
}

/** Build a knowledge-store-ready document: identifying header + full transcript. */
export function buildTranscriptDocument(r: VideoTranscript): string {
  const header: string[] = [];
  if (r.title) header.push(`# ${r.title}`);
  if (r.author) header.push(`Channel: ${r.author}`);
  header.push(`YouTube: ${r.url}`);
  if (typeof r.durationSeconds === 'number') header.push(`Duration: ${formatDuration(r.durationSeconds)}`);
  return `${header.join('\n')}\n\n${r.text ?? ''}`.trim();
}

export interface YoutubeTranscriptDetails {
  requested: number;
  fetched: number;
  failed: number;
  rejected: number;
  videoIds: string[];
}

export async function youtubeTranscriptCommand(
  opts: YoutubeTranscriptCommandOptions,
): Promise<AgentToolResult<YoutubeTranscriptDetails>> {
  const { videoIds, rejected } = selectVideoIds(opts.urls, opts.maxVideos);

  if (videoIds.length === 0) {
    metrics.increment('tool_youtube_transcript_calls_total', 1, { status: 'no_valid_videos' });
    return {
      content: [{
        type: 'text',
        text:
          '# YouTube Transcripts\n\nNo valid YouTube video links were provided. ' +
          'Pass full watch URLs (https://www.youtube.com/watch?v=…), youtu.be links, ' +
          'or shorts/embed/live links that you found in your search results.',
      }],
      details: { requested: 0, fetched: 0, failed: 0, rejected: rejected.length, videoIds: [] },
    };
  }

  const results = await fetchVideoTranscripts(videoIds, {
    lang: opts.lang,
    timeoutMs: opts.timeoutMs,
    requestKey: opts.requestKey,
    signal: opts.signal,
    onVideoComplete: opts.onVideoComplete,
  });

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  // Hand each successful transcript to the caller for knowledge-store ingestion.
  if (opts.onTranscriptDocument) {
    for (const r of succeeded) {
      if (r.text) opts.onTranscriptDocument(r.url, buildTranscriptDocument(r));
    }
  }

  metrics.increment('tool_youtube_transcript_calls_total', 1, { status: 'success' });
  metrics.increment('tool_youtube_transcript_videos_succeeded_total', succeeded.length);
  metrics.increment('tool_youtube_transcript_videos_failed_total', failed.length);

  return {
    content: [{ type: 'text', text: formatResults(results, rejected) }],
    details: {
      requested: videoIds.length,
      fetched: succeeded.length,
      failed: failed.length,
      rejected: rejected.length,
      videoIds,
    },
  };
}

function formatResults(results: VideoTranscript[], rejected: string[]): string {
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  let md = `# YouTube Transcripts (${succeeded.length} of ${results.length} retrieved)\n\n`;

  for (const r of succeeded) {
    const titleLine = r.title ? `: ${r.title}` : '';
    md += `## ${r.videoId}${titleLine}\n`;
    md += `**URL:** ${r.url}\n`;
    const meta: string[] = [];
    if (r.author) meta.push(`Channel: ${r.author}`);
    if (typeof r.durationSeconds === 'number') meta.push(`Duration: ${formatDuration(r.durationSeconds)}`);
    if (r.lang) meta.push(`Language: ${r.lang}`);
    if (typeof r.charCount === 'number') meta.push(`${r.charCount.toLocaleString()} chars`);
    if (meta.length) md += `**${meta.join(' · ')}**\n`;
    // Exact, copy-ready citation string so the report cites the real video title
    // and channel rather than a paraphrase (the watch URL is not identifiable).
    if (r.title) {
      md += `**Cite as:** '${r.title}'${r.author ? ` by ${r.author}` : ''}\n`;
    }
    md += `\n${r.text}\n\n---\n\n`;
  }

  if (failed.length > 0) {
    md += `## Unavailable (${failed.length})\n\n`;
    for (const r of failed) {
      md += `- ${r.url}: ${r.error ?? 'Unknown error'}\n`;
    }
    md += '\n';
  }

  if (rejected.length > 0) {
    md += `_Skipped ${rejected.length} non-YouTube link(s)._\n`;
  }

  return md;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
