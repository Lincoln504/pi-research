/**
 * fetch_url — request URL policy.
 *
 * Normalizes the URL the agent asked for before anything touches the network:
 *   - only http(s); a scheme-less `example.com/x` is read as https;
 *   - embedded credentials (`https://user:pass@host`) are refused;
 *   - `http:` is rewritten to `https:` (reported, never silently) — plain HTTP can
 *     be modified in transit by anyone on the network path, which for a tool that
 *     feeds the main agent means injected instructions on a trusted site;
 *   - the fragment is dropped (never sent to the server; would only split the cache).
 *
 * SSRF (private/internal addresses) is NOT decided here: scrapeSingle validates
 * every hop at connect time, which is the only place it can be done correctly.
 */

export class UrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

export interface NormalizedUrl {
  /** The URL to fetch (always https, no fragment). */
  url: string;
  /** True when the agent passed `http:` and it was rewritten to `https:`. */
  upgraded: boolean;
}

export function normalizeRequestUrl(raw: string): NormalizedUrl {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new UrlPolicyError('Empty URL.');

  // Scheme-less input ("example.com/page"): read as https. Anything with an
  // explicit scheme keeps it and is judged below.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new UrlPolicyError(`Not a valid URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlPolicyError(`Only https URLs can be fetched (got ${parsed.protocol}).`);
  }
  if (parsed.username || parsed.password) {
    throw new UrlPolicyError('URLs with embedded credentials (user:password@host) are refused.');
  }
  if (!parsed.hostname) {
    throw new UrlPolicyError(`URL has no host: ${trimmed}`);
  }

  const upgraded = parsed.protocol === 'http:';
  if (upgraded) parsed.protocol = 'https:';
  parsed.hash = '';

  return { url: parsed.href, upgraded };
}
