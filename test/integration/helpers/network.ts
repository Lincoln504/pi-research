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
    /research-state\.lock/i
];

/**
 * Checks if a given text contains common environment-related connectivity
 * errors. Used to identify transient or sandbox-specific failures in
 * integration tests.
 */
export function isNetworkUnavailable(text: string): boolean {
    return NETWORK_ERROR_PATTERNS.some(pattern => pattern.test(text));
}
