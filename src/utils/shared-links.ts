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
 * Format a lightweight update message for real-time link sharing.
 */
export function formatLightweightLinkUpdate(
  newlyScrapedUrls: string[],
  sourceResearcherId: string,
  sourceResearcherName: string
): string {
  if (newlyScrapedUrls.length === 0) return '';

  return `## Link Update: Sibling ${sourceResearcherId} (${sourceResearcherName}) Just Scraped\n\n` +
    `**${newlyScrapedUrls.length} link(s) added to shared pool:**\n` +
    newlyScrapedUrls.map(url => `- ${url}`).join('\n') +
    '\n\n> These links are now in the global pool — avoid re-scraping them.';
}

/**
 * Register links as scraped for a specific session.
 */
export function registerScrapedLinks(researchId: string, links: string[]) {
    if (!sessionLinks.has(researchId)) {
        sessionLinks.set(researchId, new Set());
    }
    const pool = sessionLinks.get(researchId)!;
    links.forEach(l => pool.add(l));
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
        if (pool.has(url)) {
            duplicates.push(url);
        } else {
            kept.push(url);
        }
    });

    return { kept, duplicates };
}

export function formatSharedLinksFromState(aspects: Record<string, any>): string {
    let output = '';
    const allAdded = new Set<string>();

    Object.values(aspects).forEach(aspect => {
        if (aspect.report) {
            // Regex to find Markdown links: [text](url)
            const urlMatches = Array.from(aspect.report.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)) as any[];
            if (urlMatches.length > 0) {
                output += `\n### Aspect: ${aspect.query} (ID: ${aspect.id})\n`;
                for (const match of urlMatches) {
                    const url = match[1]!;
                    if (!allAdded.has(url)) {
                        output += `- ${url}\n`;
                        allAdded.add(url);
                    }
                }
            }
        }
    });

    if (!output) return '';

    return '\n## Shared Links from Sibling Researchers\n' + output;
}

/**
 * Cleanup session data.
 */
export function cleanupSharedLinks(researchId: string) {
    sessionLinks.delete(researchId);
    logger.debug(`[Shared Links] Cleaned up session: ${researchId}`);
}
