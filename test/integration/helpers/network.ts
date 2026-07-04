// Transport-level connectivity/throttle markers. Any one of these alone is
// sufficient evidence of an environment (not code) failure.
const TRANSPORT_ERROR_PATTERNS: readonly RegExp[] = [
    /fetch failed/i,
    /ENOTFOUND/i,
    /EAI_AGAIN/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ERR_NAME_NOT_RESOLVED/i,
    /ERR_INTERNET_DISCONNECTED/i,
    /ERR_CONNECTION_REFUSED/i,
    /ERR_CONNECTION_RESET/i,
    /ERR_CONNECTION_TIMED_OUT/i,
    /ERR_NETWORK_CHANGED/i,
    /ERR_CONNECTION_CLOSED/i,
    /socket hang up/i,
    /EPERM: operation not permitted/i,
    /throttle_violation/i,
    /too many requests/i,
    /rate limit/i,
    // Upstream API throttling from the live third-party APIs these integration
    // tests hit (Stack Exchange / NVD / OSV / GitHub Advisory). Shared CI datacenter
    // IPs exhaust the anonymous per-IP quota, so an HTTP 429/503 is an environment
    // condition, not a code fault — treat it like any other transient network miss.
    // Anchored to the shapes the tools actually emit — "HTTP 429 from …",
    // "HTTP 429: …", "(HTTP 503)" — so a vuln description that merely mentions an
    // HTTP status in its body (e.g. "returns HTTP 503") is NOT falsely tolerated.
    /HTTP (429|503)(?::| from|\))/i,
];

// Content-shaped failure text (HTML error bodies, JSON-parse noise, total search
// failure). These shapes ALSO appear when the code itself regresses — e.g.
// src/tools/security.ts pipes a raw "Unexpected token …" JSON.parse error into
// the tool output — so on their own they must NOT be classified as an
// environment problem (that would silently skip a real regression). They only
// count when the same text carries an explicit upstream HTTP error status
// (429/5xx, the throttle/server-error range): every client in src/ throws
// "HTTP <status> …" before attempting to parse a non-ok response, so a parse
// error or HTML body WITHOUT such a marker means a 200-OK response with a bad
// body — a code/API contract failure that should fail the test.
const CONTENT_SHAPED_PATTERNS: readonly RegExp[] = [
    /<\!DOCTYPE/i,
    /<html/i,
    /unexpected token/i,
    // Browser pool / search failures
    /search completely failed/i,
];

// Same anchored shapes as above ("HTTP 502 from …", "HTTP 500: …", "(HTTP 504)"),
// widened to the full throttle/server-error range for co-occurrence validation.
const HTTP_ERROR_STATUS_MARKER = /HTTP (429|5\d\d)(?::| from|\))/i;

/**
 * Checks if a given text contains common environment-related connectivity
 * errors. Used to identify transient or sandbox-specific failures in
 * integration tests.
 *
 * Transport-level markers match on their own. Content-shaped markers (HTML
 * bodies, "unexpected token", "search completely failed") require a
 * co-occurring transport marker or an explicit HTTP 429/5xx status in the same
 * text, so a genuine parse/search regression is not misread as an environment
 * skip.
 */
export function isNetworkUnavailable(text: string): boolean {
    if (TRANSPORT_ERROR_PATTERNS.some(pattern => pattern.test(text))) return true;
    return HTTP_ERROR_STATUS_MARKER.test(text)
        && CONTENT_SHAPED_PATTERNS.some(pattern => pattern.test(text));
}
