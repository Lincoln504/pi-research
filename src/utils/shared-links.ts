/**
 * Shared Links Registry
 *
 * Provides a global registry of links scraped across all researchers
 * in a session to prevent redundant work.
 */

import { logger } from '../logger.ts';

const sessionLinks = new Map<string, Set<string>>();

/**
 * Generate a unique research ID based on the parent Pi session.
 */
export function generateSessionId(piSessionId: string): string {
    return `${piSessionId}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Format a compact link-scraped notice for sibling researchers.
 * The scrape tool enforces dedup automatically; this message is advisory context.
 */
export function formatLightweightLinkUpdate(
  newlyScrapedUrls: string[],
  sourceResearcherId: string,
  _sourceResearcherName: string
): string {
  if (newlyScrapedUrls.length === 0) return '';
  return `[Researcher ${sourceResearcherId} scraped — skip these]\n` +
    newlyScrapedUrls.map(url => `- ${url}`).join('\n');
}

/**
 * Normalize a URL for deduplication purposes.
 * - Forces HTTPS
 * - Removes trailing slashes
 * - Removes hash fragments
 * - Lowercases the hostname
 */
export function normalizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        // Force https for deduplication purposes (http and https usually point to the same content)
        parsed.protocol = 'https:';
        // Remove hash fragments
        parsed.hash = '';
        // Build the normalized string
        let normalized = parsed.toString();
        // Remove trailing slash if present
        if (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    } catch (_e) {
        // If it's an invalid URL, return it as-is or cleaned up slightly
        let cleaned = url.split('#')[0]!;
        if (cleaned.endsWith('/')) {
            cleaned = cleaned.slice(0, -1);
        }
        return cleaned.toLowerCase();
    }
}

/**
 * Register links as scraped for a specific session.
 */
export function registerScrapedLinks(researchId: string, links: string[]) {
    if (!sessionLinks.has(researchId)) {
        sessionLinks.set(researchId, new Set());
    }
    const pool = sessionLinks.get(researchId)!;
    links.forEach(l => pool.add(normalizeUrl(l)));
}

/**
 * Get all scraped links for a session.
 */
export function getScrapedLinks(researchId: string): string[] {
    return Array.from(sessionLinks.get(researchId) || []);
}

/**
 * Deduplicate a list of candidate URLs against already scraped links.
 */
export function deduplicateUrls(urls: string[], researchId: string): { kept: string[], duplicates: string[] } {
    const pool = sessionLinks.get(researchId) || new Set();
    const kept: string[] = [];
    const duplicates: string[] = [];

    urls.forEach(url => {
        const normalized = normalizeUrl(url);
        if (pool.has(normalized)) {
            duplicates.push(url); // Keep original URL for logging/display
        } else {
            kept.push(url);
        }
    });

    return { kept, duplicates };
}


/**
 * Format shared links from researcher states for context injection.
 */
export function formatSharedLinksFromState(aspects: Record<string, any>): string {
    const sections: string[] = [];
    
    for (const id in aspects) {
        const sibling = aspects[id];
        if (!sibling || !sibling.report) continue;

        const links: string[] = [];
        const report = sibling.report;
        
        // Extract from CITED LINKS
        const citedMatch = report.match(/### CITED LINKS[\s\S]*?(?:###|$)/);
        if (citedMatch) {
            const urls = citedMatch[0].match(/https?:\/\/[^\s)]+/g) || [];
            links.push(...urls);
        }

        // Extract from SCRAPE CANDIDATES
        const candidatesMatch = report.match(/### SCRAPE CANDIDATES[\s\S]*?(?:###|$)/);
        if (candidatesMatch) {
            const urls = candidatesMatch[0].match(/https?:\/\/[^\s)]+/g) || [];
            links.push(...urls);
        }

        if (links.length > 0) {
            const unique = Array.from(new Set(links));
            sections.push(`#### Aspect: ${sibling.query} (ID: ${sibling.id})\n` + unique.map(u => `- ${u}`).join('\n'));
        }
    }

    if (sections.length === 0) return '';

    return `\n---\n\n### Shared Links from Sibling Researchers\nThese URLs have already been scraped or identified by other researchers. Use them as starting points but prioritize discovering NEW high-quality sources.\n\n${sections.join('\n\n')}\n`;
}

/**
 * Reset the scrape-dedup pool for a session (call between rounds so new researchers
 * can access URLs that were scraped in the previous round).
 */
export function resetScrapedLinks(researchId: string) {
    sessionLinks.set(researchId, new Set());
    logger.debug(`[Shared Links] Reset scrape pool for: ${researchId}`);
}

/**
 * Cleanup session data.
 */
export function cleanupSharedLinks(researchId: string) {
    sessionLinks.delete(researchId);
    logger.debug(`[Shared Links] Cleaned up session: ${researchId}`);
}
