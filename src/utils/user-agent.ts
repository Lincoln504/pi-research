/**
 * Realistic User-Agent Strings for Browser Rotation
 *
 * Provides current, realistic User-Agent strings that mimic real browsers.
 * Updated regularly to match current browser versions.
 */

export const USER_AGENTS = [
    // Chrome on Windows (updated 2025)
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',

    // Chrome on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',

    // Chrome on Linux
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',

    // Firefox on Windows (updated 2025)
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',

    // Firefox on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0',
];

/**
 * Get a random realistic User-Agent string
 */
export function getRandomRealisticUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

/**
 * Get a realistic User-Agent for a specific platform
 */
export function getRealisticUA(platform: 'windows' | 'mac' | 'linux' | string): string {
    const filtered = USER_AGENTS.filter(ua => {
        if (platform === 'windows') return ua.includes('Windows');
        if (platform === 'mac') return ua.includes('Macintosh');
        if (platform === 'linux') return ua.includes('Linux');
        return true;
    });
    return filtered[Math.floor(Math.random() * filtered.length)]!;
}