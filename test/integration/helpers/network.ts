const NETWORK_ERROR_PATTERNS: readonly RegExp[] = [
    /fetch failed/i,
    /ENOTFOUND/i,
    /EAI_AGAIN/i,
    /ECONNRESET/i,
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
    // HTML error responses from APIs (application-level failures)
    /<\!DOCTYPE/i,
    /<html/i,
    /unexpected token/i,
    // Browser pool / search failures
    /search completely failed/i,
];

/**
 * Checks if a given text contains common environment-related connectivity
 * errors. Used to identify transient or sandbox-specific failures in
 * integration tests.
 */
export function isNetworkUnavailable(text: string): boolean {
    return NETWORK_ERROR_PATTERNS.some(pattern => pattern.test(text));
}
