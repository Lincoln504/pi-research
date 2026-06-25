/**
 * YouTube video-ID extraction
 *
 * Pure helpers (no I/O) for turning the URLs a researcher already has in its
 * link pool into canonical 11-character YouTube video IDs. The researcher
 * selects which YouTube links to transcribe — exactly like it selects which
 * pages to scrape — and this module validates and normalizes that selection.
 */

/** A YouTube video ID is always 11 chars from the URL-safe base64 alphabet. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

/** Path prefixes that carry the video ID as the next path segment. */
const PATH_PREFIXES = ['embed', 'shorts', 'live', 'v'];

/**
 * Returns true when the input looks like a YouTube watch/share URL (or a bare
 * 11-char video ID). Used to filter a mixed link pool down to YouTube links.
 */
export function isYoutubeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (VIDEO_ID_RE.test(trimmed)) return true;
  try {
    const url = new URL(trimmed);
    return YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Extract the canonical 11-character video ID from any common YouTube URL form,
 * or from a bare ID. Returns null when no valid ID can be found — callers must
 * treat null as "not a usable YouTube video" and skip it.
 *
 * Handles:
 *   - bare ID:                         dQw4w9WgXcQ
 *   - youtu.be/<id>:                   https://youtu.be/dQw4w9WgXcQ?si=...
 *   - watch?v=<id>:                    https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42
 *   - /embed/<id>, /shorts/<id>,
 *     /live/<id>, /v/<id>:             https://www.youtube.com/shorts/dQw4w9WgXcQ
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  // watch?v=<id> (also covers /watch and music.youtube.com/watch)
  const vParam = url.searchParams.get('v');
  if (vParam && VIDEO_ID_RE.test(vParam)) return vParam;

  // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && PATH_PREFIXES.includes(segments[0]!.toLowerCase())) {
    const id = segments[1]!;
    if (VIDEO_ID_RE.test(id)) return id;
  }

  return null;
}

/**
 * Map a list of raw link-pool entries to a deduplicated list of valid video IDs
 * (preserving order, capped to `max`), while reporting which inputs were not
 * usable YouTube links so the caller can surface that to the agent.
 */
export function selectVideoIds(
  urls: string[],
  max: number,
): { videoIds: string[]; rejected: string[] } {
  const seen = new Set<string>();
  const videoIds: string[] = [];
  const rejected: string[] = [];

  for (const raw of urls) {
    const id = extractVideoId(raw);
    if (!id) {
      rejected.push(raw);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (videoIds.length < max) videoIds.push(id);
  }

  return { videoIds, rejected };
}

/** Canonical watch URL for a video ID (used in result formatting). */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
