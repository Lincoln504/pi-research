/**
 * YouTube transcript client
 *
 * Fetches transcripts for a batch of video IDs using youtubei.js (InnerTube) for
 * metadata + caption-track discovery and a direct timedtext request for the
 * caption content, authenticated with a content-bound PoToken.
 *
 * Design notes:
 *  - `getTranscript()` (the get_transcript endpoint) is deliberately NOT used: it
 *    returns 400 FAILED_PRECONDITION even with a valid PoToken. The caption track
 *    (timedtext, fmt=json3) is fetched directly instead.
 *  - Empty-body guard: the timedtext endpoint returns HTTP 200 with an empty body
 *    when the PoToken is missing/invalid. Empty or whitespace-only transcripts are
 *    treated as failures and never surfaced as blank successes.
 *  - Per-video isolation: one failed/unavailable video never aborts the batch.
 *  - All network work is bounded by a per-video timeout and guarded by a shared
 *    circuit breaker so a YouTube outage fails fast instead of hanging researchers.
 */

import { withTimeout, retryWithBackoff, createTimeoutSignal } from '../web-research/retry-utils.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { mintPoTokens } from './potoken.ts';
import { watchUrl } from './video-id.ts';

export interface VideoTranscript {
  videoId: string;
  url: string;
  success: boolean;
  title?: string;
  author?: string;
  durationSeconds?: number;
  lang?: string;
  text?: string;
  charCount?: number;
  error?: string;
}

export interface FetchTranscriptsOptions {
  /** Preferred caption language (BCP-47 prefix, e.g. 'en'). Defaults to 'en'. */
  lang?: string;
  /** Per-video timeout in milliseconds. Defaults to 20000. */
  timeoutMs?: number;
  /** PoToken request key override. */
  requestKey?: string;
  /** Caller cancellation signal. */
  signal?: AbortSignal;
  /** Fires as each video completes (success or failure) — used for TUI flashes. */
  onVideoComplete?: (videoId: string, success: boolean) => void;
}

// Shared breaker: a sustained YouTube/attestation outage trips it so subsequent
// researchers fail fast rather than each waiting out the full timeout.
const breaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  name: 'YouTube transcript',
  isTransientError: (err) => {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('network') ||
      msg.includes('econn') ||
      msg.includes('fetch failed') ||
      msg.includes('429') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503')
    );
  },
});

interface CaptionTrack {
  base_url: string;
  language_code?: string;
  kind?: string;
}

/**
 * Fetch transcripts for up to a handful of video IDs. Always resolves with one
 * result per input ID (never throws for individual-video problems); only a
 * total infrastructure failure (e.g. youtubei.js unavailable) rejects.
 */
export async function fetchVideoTranscripts(
  videoIds: string[],
  opts: FetchTranscriptsOptions = {},
): Promise<VideoTranscript[]> {
  const lang = opts.lang || 'en';
  const timeoutMs = opts.timeoutMs ?? 20000;
  const signal = opts.signal;

  if (videoIds.length === 0) return [];

  // Lazy-load youtubei.js — never imported at module load (keeps startup native-free).
  const yt = await import('youtubei.js');
  const { Innertube } = yt;
  // Silence youtubei.js's own console logging — it writes parser warnings
  // straight to the console, which would corrupt the TUI (stdout is the UI).
  try {
    const log = (yt as unknown as { Log?: { setLevel?: (n: number) => void; Level?: { NONE: number } } }).Log;
    if (log?.setLevel && log.Level) log.setLevel(log.Level.NONE);
  } catch {
    // non-fatal: logging stays at default if the API ever changes
  }
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  // 1) Throwaway session to obtain stable visitor data for the PoToken binding.
  let visitorData: string;
  try {
    const seed = await withTimeout(
      Innertube.create({ retrieve_player: false }),
      timeoutMs,
      'youtube:create-seed-session',
      signal,
    );
    visitorData = seed.session.context?.client?.visitorData ?? '';
  } catch (error) {
    logger.warn(`[youtube] Failed to create seed session: ${msg(error)}`);
    return videoIds.map((videoId) => failure(videoId, 'Could not initialize YouTube session.'));
  }
  if (!visitorData) {
    return videoIds.map((videoId) => failure(videoId, 'YouTube did not return visitor data.'));
  }

  // 2) Mint a session token + one content-bound token per video, all at once.
  //    Bounded by withTimeout + the caller's signal so a hung BotGuard challenge
  //    can never stall the researcher.
  let tokens: Map<string, string>;
  try {
    // Pass a timeout-combined signal INTO the mint, not just to withTimeout's wrapper. doMint
    // threads opts.signal into its BotGuard challenge/integrity fetches, so this makes the timeout
    // actually abort an in-flight mint and release the process-wide mintChain mutex. Previously the
    // raw researcher signal was passed, so on timeout withTimeout rejected the wrapper while doMint
    // kept running and held the mutex forever — one stalled Google socket then hung every later
    // YouTube mint in the run (each surfacing as a 20s "token unavailable").
    const mintSignal = createTimeoutSignal(timeoutMs, signal);
    tokens = await withTimeout(
      mintPoTokens([visitorData, ...videoIds], { requestKey: opts.requestKey, fetchImpl, signal: mintSignal }),
      timeoutMs,
      'youtube:mint',
      signal,
    );
  } catch (error) {
    // Without a PoToken, timedtext silently returns empty — so degrade honestly:
    // report every video as unavailable with the real reason.
    const reason = `Bot-protection token unavailable (${msg(error)}). YouTube transcripts require a residential IP.`;
    return videoIds.map((videoId) => failure(videoId, reason));
  }

  const sessionToken = tokens.get(visitorData);
  if (!sessionToken) {
    return videoIds.map((videoId) => failure(videoId, 'Failed to mint a YouTube session token.'));
  }

  // 3) Real session, bound to the session token + visitor data, with player
  //    retrieval enabled so caption tracks are present on getInfo().
  let session: Awaited<ReturnType<typeof Innertube.create>>;
  try {
    session = await withTimeout(
      Innertube.create({ po_token: sessionToken, visitor_data: visitorData, retrieve_player: true }),
      timeoutMs,
      'youtube:create-session',
      signal,
    );
  } catch (error) {
    logger.warn(`[youtube] Failed to create authenticated session: ${msg(error)}`);
    return videoIds.map((videoId) => failure(videoId, 'Could not initialize authenticated YouTube session.'));
  }

  // 4) Fetch each video's transcript independently (bounded + isolated).
  const results = await Promise.all(
    videoIds.map((videoId) =>
      fetchOne(session, videoId, tokens.get(videoId), lang, timeoutMs, signal, fetchImpl)
        .then((result) => {
          // Guard the caller-supplied callback: a throwing callback must never
          // reject Promise.all and break the never-throws contract.
          try {
            opts.onVideoComplete?.(videoId, result.success);
          } catch {
            // ignore callback errors
          }
          return result;
        }),
    ),
  );

  // youtubei.js Innertube sessions are plain GC'd objects with no disposer and
  // no per-session sockets (Node fetch uses a shared agent), so there is nothing
  // to close here.
  return results;
}

async function fetchOne(
  session: { getInfo(id: string): Promise<unknown> },
  videoId: string,
  contentToken: string | undefined,
  lang: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<VideoTranscript> {
  const started = Date.now();
  try {
    if (!contentToken) {
      return failure(videoId, 'No content-bound token was minted for this video.');
    }

    const result = await breaker.execute(() =>
      retryWithBackoff(
        async () => {
          const info = (await withTimeout(
            session.getInfo(videoId) as Promise<VideoInfoLike>,
            timeoutMs,
            `youtube:getInfo:${videoId}`,
            signal,
          )) as VideoInfoLike;

          const tracks = (info.captions?.caption_tracks ?? []) as CaptionTrack[];
          const track = pickTrack(tracks, lang);
          if (!track) {
            // No captions at all — a permanent condition; do not retry.
            throw new PermanentError('No captions/transcript available for this video.');
          }

          // base_url is parsed out of YouTube's getInfo() response. Defense in
          // depth: it must be an https YouTube/Google timedtext host before we
          // append the PoToken and fetch it — never a private/metadata target.
          assertTrustedTimedtextUrl(track.base_url);

          const sep = track.base_url.includes('?') ? '&' : '?';
          const url = `${track.base_url}${sep}fmt=json3&c=WEB&pot=${encodeURIComponent(contentToken)}`;
          // Pass a combined timeout+caller signal straight into fetch so BOTH the
          // response headers AND the body read are bounded and tear the socket
          // down on timeout/cancellation (withTimeout alone would not bound text()).
          const fetchSignal = createTimeoutSignal(timeoutMs, signal);
          const response = await fetchImpl(url, {
            signal: fetchSignal,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': lang },
          });
          // Surface the real HTTP status. Without this, a 403 (age-restricted) or
          // 404 (removed) returns HTML that parseJson3 yields '' for, which would
          // be misreported below as a bot-protection/PoToken failure.
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} from timedtext endpoint`);
          }
          const body = await response.text();
          const text = parseJson3(body);

          // Empty-body guard: HTTP 200 + empty body == silent PoToken failure.
          if (!text) {
            throw new Error('Empty transcript body (bot-protection rejected the token).');
          }

          return {
            info,
            track,
            text,
          };
        },
        {
          maxRetries: 1,
          initialDelay: 500,
          maxDelay: 2000,
          label: `youtube:${videoId}`,
          isTransientError: (err) => !(err instanceof PermanentError),
        },
      ),
    );

    const basic = (result.info.basic_info ?? {}) as Record<string, unknown>;
    metrics.observe('youtube_transcript_fetch_duration_ms', Date.now() - started, { status: 'success' });
    metrics.increment('youtube_transcript_videos_total', 1, { status: 'success' });
    return {
      videoId,
      url: watchUrl(videoId),
      success: true,
      title: typeof basic['title'] === 'string' ? (basic['title'] as string) : undefined,
      author: typeof basic['author'] === 'string' ? (basic['author'] as string) : undefined,
      durationSeconds: typeof basic['duration'] === 'number' ? (basic['duration'] as number) : undefined,
      lang: result.track.language_code,
      text: result.text,
      charCount: result.text.length,
    };
  } catch (error) {
    metrics.observe('youtube_transcript_fetch_duration_ms', Date.now() - started, { status: 'error' });
    metrics.increment('youtube_transcript_videos_total', 1, { status: 'error' });
    logger.warn(`[youtube] Transcript fetch failed for ${videoId}: ${msg(error)}`);
    return failure(videoId, normalizeVideoError(error));
  }
}

/** Select the best caption track: exact lang → lang-prefix → human (non-asr) → first. */
function pickTrack(tracks: CaptionTrack[], lang: string): CaptionTrack | undefined {
  if (tracks.length === 0) return undefined;
  return (
    tracks.find((t) => t.language_code === lang) ??
    tracks.find((t) => t.language_code?.startsWith(lang)) ??
    tracks.find((t) => t.kind !== 'asr') ??
    tracks[0]
  );
}

/** Parse YouTube json3 caption payload into a single whitespace-collapsed string. */
/**
 * Defense-in-depth SSRF gate for the timedtext URL. The base_url comes from
 * youtubei.js parsing YouTube's getInfo() response; this guarantees we only ever
 * fetch it if it is https on a YouTube/Google-owned host, so a manipulated or
 * misparsed value can never point the PoToken-bearing request at an internal IP
 * or the cloud metadata endpoint. Throws PermanentError (no retry) on mismatch.
 */
function assertTrustedTimedtextUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PermanentError('Caption track URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new PermanentError(`Caption track URL must be https (got ${parsed.protocol}).`);
  }
  const host = parsed.hostname.toLowerCase();
  const ok =
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host.endsWith('.googlevideo.com') ||
    host.endsWith('.google.com') ||
    host.endsWith('.googleapis.com');
  if (!ok) {
    throw new PermanentError(`Caption track URL host not trusted: ${host}`);
  }
}

function parseJson3(body: string): string {
  if (!body) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  const events = (parsed as { events?: unknown[] }).events;
  if (!Array.isArray(events)) return '';
  let out = '';
  for (const event of events) {
    const segs = (event as { segs?: unknown[] }).segs;
    if (!Array.isArray(segs)) continue;
    for (const seg of segs) {
      const utf8 = (seg as { utf8?: unknown }).utf8;
      if (typeof utf8 === 'string') out += utf8;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function failure(videoId: string, error: string): VideoTranscript {
  return { videoId, url: watchUrl(videoId), success: false, error };
}

function normalizeVideoError(error: unknown): string {
  const m = msg(error);
  if (/cancelled or timed out/i.test(m)) return 'Timed out fetching this video.';
  return m;
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Marks a non-retryable condition (e.g. captions disabled). */
class PermanentError extends Error {}

interface VideoInfoLike {
  basic_info?: Record<string, unknown>;
  captions?: { caption_tracks?: CaptionTrack[] };
}
