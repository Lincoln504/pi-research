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
    // Stack Exchange's structured throttle wrapper — anchored to the exact prefix
    // the client emits ("Stack Exchange API Error (502 - throttle_violation): too
    // many requests from this ip…", src/stackexchange/rest-client.ts), so a result
    // body that merely mentions throttling is NOT misread as an environment failure.
    /Stack Exchange API Error \(\d+ - throttle_violation\)/i,
    // NVD's and GitHub's throttle errors ("NVD API rate limit exceeded (HTTP 429).
    // Retrying with backoff…", "GitHub API rate limit exceeded (HTTP 403)…") —
    // anchored the same way; a bare "rate limit" in an advisory description must
    // not skip the test. Every other upstream 429 surfaces as statusText behind an
    // "HTTP 429:" prefix and is matched by the anchored pattern below.
    /rate limit exceeded \(HTTP (429|403)\)/i,
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

// A SUCCESSFUL Stack Exchange API round-trip that nonetheless returned ZERO
// items. Distinct from the throttle/transport cases above: the API answered
// 200-OK, consumed quota, and simply had nothing for the query. The Stack
// Exchange search endpoints intermittently return empty `items:[]` for queries
// that normally have thousands of results (verified 2026-08-03: `q=javascript`
// on stackoverflow returned `[]` from a residential IP with quota ticking down) —
// an upstream API degradation / contract drift, NOT a pi-research code fault
// and NOT a datacenter-IP block. Gating a release on it would hand every publish
// to a third party the project cannot control, so the SE integration tests skip
// (visibly, via ctx.skip) in this case — exactly as they already do on a 429.
//
// Safety: the `**API Quota:**` footer is emitted ONLY by the Stack Exchange
// tool after a successful client round-trip (src/stackexchange/index.ts), so
// this can never match security/search/scrape/other-tool output and cannot mask
// a regression elsewhere. The empty body is either the zero-item JSON fallback
// ("[]") or a named-formatter "No questions/answers/users/sites found." string.
const STACK_EXCHANGE_EMPTY_RESULT = /API Quota:/i;
const STACK_EXCHANGE_EMPTY_BODY = /(^|\n)\[\](\s*\n|$)|No (questions|answers|users|sites) found/i;

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
 *
 * A successful-but-empty Stack Exchange response also counts as unavailable: it
 * is an upstream condition (the API returned no usable data), not a code defect.
 */
export function isNetworkUnavailable(text: string): boolean {
    if (TRANSPORT_ERROR_PATTERNS.some(pattern => pattern.test(text))) return true;
    if (HTTP_ERROR_STATUS_MARKER.test(text)
        && CONTENT_SHAPED_PATTERNS.some(pattern => pattern.test(text))) return true;
    return STACK_EXCHANGE_EMPTY_RESULT.test(text) && STACK_EXCHANGE_EMPTY_BODY.test(text);
}
