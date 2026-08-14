/**
 * Realistic User-Agent Strings for Browser Rotation
 *
 * Sent by the FETCH scrape path (web-scraper.ts); the stealth browser path
 * supplies its own fingerprint-consistent UA via camoufox.
 *
 * These have a shelf life. Both browsers ship a major version roughly every
 * four weeks, and a UA more than a few majors behind stable is itself a
 * bot signal — the exact thing rotating them is meant to avoid. Refresh the
 * two Chrome and two Firefox majors below when they drift; keep the platform
 * tokens as-is (Chrome freezes the macOS token at 10_15_7 and zeroes the
 * minor version triplet, Firefox mirrors its major in both `rv:` and the
 * trailing `Firefox/` token).
 *
 * Last refreshed 2026-08-14 against Chrome 151 stable (Chrome Releases,
 * 2026-07-28) and Firefox 153 stable (firefox.com release notes, 2026-08-11).
 */

export const USER_AGENTS = [
    // Chrome on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',

    // Chrome on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',

    // Chrome on Linux
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',

    // Firefox on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',

    // Firefox on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
];
