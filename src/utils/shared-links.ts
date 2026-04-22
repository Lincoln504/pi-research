/**
 * Shared Links Pool Management
 *
 * Centralized deterministic link state management system.
 * Single source of truth: global allScrapedLinks array.
 * No per-session state - everything flows through global state.
 */

import * as crypto from 'node:crypto';

/**
 * Generate a 4-character alphanumeric hash
 */
function generate4CharHash(): string {
  // Use randomBytes for Node.js environments, fallback to Math.random for test environments
  let hash: string;
  try {
    const bytes = crypto.randomBytes(2);
    hash = bytes.toString('hex').substring(0, 4);
  } catch {
    // Fallback for test environments where crypto.randomBytes might not be available
    // Generate a valid 4-character hex string
    const randomHex = Math.floor(Math.random() * 65536).toString(16).padStart(4, '0');
    hash = randomHex;
  }
  return hash;
}

/**
 * Generate a unique session ID with 4-char hash
 * @param baseId Base identifier (e.g., request ID)
 * @returns Unique session ID (e.g., "abc123-x9k2")
 */
export function generateSessionId(baseId: string): string {
  const hash = generate4CharHash();
  return `${baseId}-${hash}`;
}

/**
 * Normalize a URL for comparison (lowercase, remove trailing slash)
 */
export function normalizeUrl(url: string): string {
  try {
    const normalized = url.toLowerCase().trim();
    // Remove trailing slash except for root
    if (normalized.length > 1 && normalized.endsWith('/')) {
      return normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url.toLowerCase().trim();
  }
}

/**
 * Deduplicate a list of URLs against already-scraped URLs.
 * Uses normalized comparison for accuracy.
 * 
 * @param urls - URLs to check
 * @param alreadyScraped - Array of already-scraped URLs
 * @returns Object with kept URLs and removed duplicates
 */
export function deduplicateUrls(urls: string[], alreadyScraped: string[]): {
  kept: string[];
  duplicates: string[];
} {
  const normalizedAlreadyScraped = new Set(
    alreadyScraped.map(normalizeUrl)
  );

  const kept: string[] = [];
  const duplicates: string[] = [];

  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (normalizedAlreadyScraped.has(normalized)) {
      duplicates.push(url);
    } else {
      kept.push(url);
    }
  }

  return { kept, duplicates };
}

/**
 * Format a lightweight link update message for real-time injection into running siblings.
 * Used when a researcher scrapes new URLs to immediately inform other running researchers.
 * 
 * @param newlyScrapedUrls - URLs that were just scraped
 * @param sourceResearcherId - ID of the researcher that scraped these URLs
 * @param sourceResearcherQuery - Query/topic of the source researcher
 * @returns Formatted message for injection via session.steer()
 */
export function formatLightweightLinkUpdate(
  newlyScrapedUrls: string[],
  sourceResearcherId: string,
  sourceResearcherQuery: string
): string {
  if (newlyScrapedUrls.length === 0) return '';

  // Create a brief context phrase (less than a sentence)
  const contextPhrase = sourceResearcherQuery.length > 60
    ? sourceResearcherQuery.slice(0, 60) + '...'
    : sourceResearcherQuery;

  return `## Link Update: Sibling ${sourceResearcherId} Just Scraped

**Topic**: ${contextPhrase}

**${newlyScrapedUrls.length} link(s) added to shared pool:**
${newlyScrapedUrls.map(url => `- ${url}`).join('\n')}

> These links are now in the global pool — avoid re-scraping them.
`;
}

/**
 * Format all completed reports into a shared links section for researcher prompts.
 * Extracts links from CITED LINKS and SCRAPE CANDIDATES sections.
 */
export function formatSharedLinksFromState(aspects: Record<string, { id: string; query: string; report?: string }>): string {
  const completed = Object.values(aspects).filter(a => a.report);
  if (completed.length === 0) return '';

  let output = '## Shared Links from Previous Research\n\n';
  output += 'The following links have already been examined by your siblings:\n\n';

  // Extract all unique URLs for quick reference
  const allUrls = new Set<string>();
  for (const aspect of completed) {
    const response = aspect.report!;
    const urlMatches = response.matchAll(/\[[^\]]+\]\((https?:\/\/[^\)]+)\)/g);
    for (const match of urlMatches) {
      allUrls.add(match[2]!);
    }
  }

  output += `### URLs in Shared Pool (${allUrls.size} total)\n\n`;
  output += Array.from(allUrls).map(url => `- ${url}`).join('\n') + '\n\n';

  // Detailed breakdown by researcher
  output += '### Detailed Breakdown by Researcher\n\n';

  for (const aspect of completed) {
    const response = aspect.report!;
    output += `### Aspect: ${aspect.query} (ID: ${aspect.id})\n\n`;

    // Extract CITED LINKS
    const citedMatch = response.match(/###?\s*CITED\s*LINKS?\s*\n([\s\S]*?)(?=\n###|$)/i);
    if (citedMatch) {
      output += '#### CITED LINKS\n';
      output += citedMatch[1]!.trim() + '\n\n';
    }

    // Extract SCRAPE CANDIDATES
    const candidatesMatch = response.match(/###?\s*SCRAPE\s*CANDIDATES?\s*\n([\s\S]*?)(?=\n###|$)/i);
    if (candidatesMatch) {
      output += '#### SCRAPE CANDIDATES\n';
      output += candidatesMatch[1]!.trim() + '\n\n';
    }
  }

  output += '**Review these links before scraping to avoid redundancy.**\n';
  return output;
}

/**
 * Legacy stub for compatibility
 */
export function cleanupSharedLinks(_sessionId: string): void {}
