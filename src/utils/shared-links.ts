/**
 * Shared Links Pool Management
 *
 * Maintains a shared pool of links across researchers to prevent
 * redundant scraping.
 */

import * as crypto from 'crypto';

/**
 * Regex patterns for parsing link sections
 */
const CITED_SECTION_REGEX = /###?\s*CITED\s*LINKS?\s*\n([\s\S]*?)(?=\n###|$)/i;
const CANDIDATES_SECTION_REGEX = /###?\s*SCRAPE\s*CANDIDATES?\s*\n([\s\S]*?)(?=\n###|$)/i;

/**
 * Generate a 4-character alphanumeric hash
 */
function generate4CharHash(): string {
  const bytes = crypto.randomBytes(2);
  const hash = bytes.toString('hex').substring(0, 4);
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
 * Format all completed reports into a shared links section for researcher prompts.
 */
export function formatSharedLinksFromState(aspects: Record<string, { id: string; query: string; report?: string }>): string {
  const completed = Object.values(aspects).filter(a => a.report);
  if (completed.length === 0) return '';

  let output = '## Shared Links from Previous Research\n\n';
  output += 'The following links have already been examined by your siblings:\n\n';

  for (const aspect of completed) {
    const response = aspect.report!;
    output += `### Aspect: ${aspect.query} (ID: ${aspect.id})\n\n`;

    // Extract CITED LINKS
    const citedMatch = response.match(CITED_SECTION_REGEX);
    if (citedMatch) {
      output += '#### CITED LINKS\n';
      output += citedMatch[1]!.trim() + '\n\n';
    }

    // Extract SCRAPE CANDIDATES
    const candidatesMatch = response.match(CANDIDATES_SECTION_REGEX);
    if (candidatesMatch) {
      output += '#### SCRAPE CANDIDATES\n';
      output += candidatesMatch[1]!.trim() + '\n\n';
    }
  }

  output += '**Review these links before scraping to avoid redundancy.**\n';
  return output;
}

/**
 * Legacy stubs for compatibility (no-ops)
 */
export function cleanupSharedLinks(_sessionId: string): void {}
