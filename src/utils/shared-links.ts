/**
 * Shared Links Registry
 *
 * Provides a global registry of links scraped across all researchers
 * in a session to prevent redundant work.
 */

import { logger } from '../logger.ts';
import { randomUUID } from 'node:crypto';

const sessionLinks = new Map<string, Set<string>>();
const sessionScrapedContent = new Map<string, Map<string, string>>();

// FIX (Issue 12): Track creation timestamps for orphaned-entry cleanup.
const sessionTimestamps = new Map<string, number>();
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

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
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[Shared Links] Cleaned up ${cleaned} orphaned session(s) older than ${SESSION_MAX_AGE_MS / 60000} minutes`);
    }
  }, 15 * 60 * 1000);
  if (cleanupInterval && (cleanupInterval as any).unref) {
    (cleanupInterval as any).unref();
  }
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
    sessionScrapedContent.get(researchId)!.set(normalizeUrl(url), content);
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
        // Strip trailing markdown markers if any (e.g. trailing **)
        const cleanUrl = url.trim().replace(/[*_~`]+$/, '');
        const parsed = new URL(cleanUrl);
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
        // Remove trailing question mark if present (no query params)
        if (normalized.endsWith('?')) {
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
 * Reset the scrape-dedup pool for a session (call between rounds so new researchers
 * can access URLs that were scraped in the previous round).
 */
export function resetScrapedLinks(researchId: string) {
    sessionLinks.set(researchId, new Set());
    // Refresh the timestamp so this session isn't prematurely evicted by the orphan cleanup timer
    sessionTimestamps.set(researchId, Date.now());
    logger.debug(`[Shared Links] Reset scrape pool for: ${researchId}`);
}

/**
 * Cleanup session data.
 */
export function cleanupSharedLinks(researchId: string) {
    sessionLinks.delete(researchId);
    sessionScrapedContent.delete(researchId);
    sessionTimestamps.delete(researchId);
    logger.debug(`[Shared Links] Cleaned up session: ${researchId}`);
}
