/**
 * Shared Links Registry
 *
 * Provides a global registry of links scraped across all researchers
 * in a session to prevent redundant work.
 */

import { normalizeUrl } from './url-utils.ts';
export { normalizeUrl };
import { logger } from '../logger.ts';
import { safeUnref } from './safe-unref.ts';
import { randomUUID } from 'node:crypto';

const sessionLinks = new Map<string, Set<string>>();
const sessionScrapedContent = new Map<string, Map<string, string>>();
// Per-researcher scrape tracking: researchId → researcherId → Set<normalizedUrl>
const researcherScrapes = new Map<string, Map<string, Set<string>>>();

// FIX (Issue 12): Track creation timestamps for orphaned-entry cleanup.
const sessionTimestamps = new Map<string, number>();
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
// FIX (#20): Cap per-session cached content to prevent unbounded memory growth
const MAX_CACHED_CONTENT_PER_SESSION = 500;

// Periodic cleanup of orphaned sessions (every 15 minutes)
let cleanupInterval: NodeJS.Timeout | null = null;

function startCleanupTimer(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [researchId, createdAt] of sessionTimestamps.entries()) {
      if (now - createdAt > SESSION_MAX_AGE_MS) {
        sessionLinks.delete(researchId);
        sessionScrapedContent.delete(researchId);
        sessionTimestamps.delete(researchId);
        researcherScrapes.delete(researchId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[Shared Links] Cleaned up ${cleaned} orphaned session(s) older than ${SESSION_MAX_AGE_MS / 60000} minutes`);
    }
  }, 15 * 60 * 1000);
  if (cleanupInterval) safeUnref(cleanupInterval);
}

// Start on module load
startCleanupTimer();

/**
 * Cache the raw markdown of a scraped URL during a research session.
 * This is used later to embed the raw text alongside the agent's summary.
 */
export function cacheScrapedContent(researchId: string, url: string, content: string) {
    if (!sessionScrapedContent.has(researchId)) {
        sessionScrapedContent.set(researchId, new Map());
        sessionTimestamps.set(researchId, Date.now());
    }
    const cache = sessionScrapedContent.get(researchId)!;
    // FIX (#20): Evict oldest entry if at capacity
    if (cache.size >= MAX_CACHED_CONTENT_PER_SESSION) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(normalizeUrl(url), content);
}

/**
 * Retrieve the cached raw markdown for a scraped URL.
 */
export function getCachedScrapedContent(researchId: string, url: string): string | undefined {
    return sessionScrapedContent.get(researchId)?.get(normalizeUrl(url));
}

/**
 * Generate a unique research ID based on the parent Pi session.
 */
export function generateSessionId(piSessionId: string): string {
    return `${piSessionId}-${randomUUID().replace(/-/g, '').substring(0, 8)}`;
}

/**
 * Register links as scraped for a specific session.
 */
export function registerScrapedLinks(researchId: string, links: string[]) {
    if (!sessionLinks.has(researchId)) {
        sessionLinks.set(researchId, new Set());
        sessionTimestamps.set(researchId, Date.now());
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
 * Cleanup session data.
 */
export function cleanupSharedLinks(researchId: string) {
    sessionLinks.delete(researchId);
    sessionScrapedContent.delete(researchId);
    sessionTimestamps.delete(researchId);
    researcherScrapes.delete(researchId);
    logger.debug(`[Shared Links] Cleaned up session: ${researchId}`);
}

/**
 * Cleanup ALL session data and stop the background timer.
 * Used during system shutdown to prevent memory leaks.
 */
export function clearAllSharedLinks(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
    sessionLinks.clear();
    sessionScrapedContent.clear();
    sessionTimestamps.clear();
    researcherScrapes.clear();
    logger.debug('[Shared Links] All global state cleared');
}

/**
 * Register that a specific researcher scraped a set of URLs.
 */
export function registerResearcherScrapes(researchId: string, researcherId: string, urls: string[]) {
    if (!researcherScrapes.has(researchId)) {
        researcherScrapes.set(researchId, new Map());
    }
    const map = researcherScrapes.get(researchId)!;
    if (!map.has(researcherId)) {
        map.set(researcherId, new Set());
    }
    const set = map.get(researcherId)!;
    urls.forEach(url => set.add(normalizeUrl(url)));
}

/**
 * Check if a specific researcher scraped a given URL.
 */
export function didResearcherScrape(researchId: string, researcherId: string, url: string): boolean {
    return researcherScrapes.get(researchId)?.get(researcherId)?.has(normalizeUrl(url)) ?? false;
}

/**
 * Get all URLs scraped by a specific researcher.
 */
export function getResearcherScrapes(researchId: string, researcherId: string): string[] {
    return Array.from(researcherScrapes.get(researchId)?.get(researcherId) ?? []);
}

/**
 * Build the Session URL Pool footer for scrape responses.
 * Shows URLs previously scraped in the session, filtered to exclude the current batch.
 * Capped at MAX_FOOTER_URLS (20).
 */
const MAX_FOOTER_URLS = 20;

export function buildSessionPoolFooter(researchId: string, currentBatchUrls: string[], researcherId?: string): string {
    const pool = sessionLinks.get(researchId);
    if (!pool || pool.size === 0) return '';

    const currentNormalized = new Set(currentBatchUrls.map(u => normalizeUrl(u)));
    // Also exclude URLs the current researcher already scraped in earlier batches
    if (researcherId) {
      const ownScrapes = researcherScrapes.get(researchId)?.get(researcherId);
      if (ownScrapes) {
        for (const url of ownScrapes) {
          currentNormalized.add(url);
        }
      }
    }
    const eligible = Array.from(pool).filter(u => !currentNormalized.has(u));
    if (eligible.length === 0) return '';

    const capped = eligible.slice(-MAX_FOOTER_URLS);
    const overflow = eligible.length - capped.length;

    let footer = '\n---\n## Session URL Pool\n';
    footer += 'Info only — URLs scraped by other researchers in this session. Do NOT use these in your report.\n';
    for (const url of capped) {
        footer += `- ${url}\n`;
    }
    if (overflow > 0) {
        footer += `*...and ${overflow} more*\n`;
    }
    return footer;
}
