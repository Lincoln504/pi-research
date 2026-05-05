/**
 * Checks if a given text contains common network-related error messages.
 * Used to identify transient network failures in integration tests.
 */
export function isNetworkUnavailable(text: string): boolean {
    const networkErrorPatterns = [
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
        /socket hang up/i
    ];

    return networkErrorPatterns.some(pattern => pattern.test(text));
}
