/**
 * Shared Links Pool Management
 *
 * Maintains a shared pool of links across researchers to prevent
 * redundant scraping and enable coordination between researchers.
 *
 * Files are stored as: /tmp/research-links-{baseId}{hash}.json
 * - baseId: Session identifier (e.g., from request ID)
 * - hash: 4-char alphanumeric for uniqueness
 *
 * Example: /tmp/research-links-abc123-x9k2.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../logger.ts';

/**
 * A single entry in the shared links pool for one researcher
 */
export interface SharedLinksEntry {
  /** Links that were actually cited in the researcher's summary */
  cited: Array<{
    url: string;
    description: string;
  }>;

  /** Links that were scraped/examined but NOT used in final response */
  candidates: Array<{
    url: string;
    reason: string;
  }>;
}

/**
 * The complete shared links pool across all researchers
 * Maps researcher ID (e.g., "1", "2") to their links
 */
export interface SharedLinksPool {
  [researcherId: string]: SharedLinksEntry;
}

/**
 * Parse a researcher's response to extract cited links and scrape candidates
 */
export interface ParsedLinks {
  cited: Array<{ url: string; description: string }>;
  candidates: Array<{ url: string; reason: string }>;
}

/**
 * Regex patterns for parsing link sections
 */
const CITED_SECTION_REGEX = /###?\s*CITED\s*LINKS?\s*\n([\s\S]*?)(?=\n###|$)/i;
const CANDIDATES_SECTION_REGEX = /###?\s*SCRAPE\s*CANDIDATES?\s*\n([\s\S]*?)(?=\n###|$)/i;
const BULLET_LINK_REGEX = /\*\s*\[([^\]]+)\]\s*(-\s*(.+))?$/gm;

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
 * Parse a researcher's markdown response to extract link sections
 * @param researcherResponse The researcher's full response
 * @returns Parsed cited links and scrape candidates
 */
export function parseResearcherLinks(researcherResponse: string): ParsedLinks {
  const cited: Array<{ url: string; description: string }> = [];
  const candidates: Array<{ url: string; reason: string }> = [];

  // Extract CITED LINKS section
  const citedMatch = researcherResponse.match(CITED_SECTION_REGEX);
  if (citedMatch) {
    const sectionContent = citedMatch[1]!;
    let match;
    while ((match = BULLET_LINK_REGEX.exec(sectionContent)) !== null) {
      cited.push({
        url: match[1]!.trim(),
        description: match[3]?.trim() || ''
      });
    }
  }

  // Extract SCRAPE CANDIDATES section
  const candidatesMatch = researcherResponse.match(CANDIDATES_SECTION_REGEX);
  if (candidatesMatch) {
    const sectionContent = candidatesMatch[1]!;
    let match;
    while ((match = BULLET_LINK_REGEX.exec(sectionContent)) !== null) {
      candidates.push({
        url: match[1]!.trim(),
        reason: match[3]?.trim() || 'No reason provided'
      });
    }
  }

  return { cited, candidates };
}

/**
 * Build a shared links pool from multiple researcher responses
 * @param responses Map of researcher ID to researcher response
 * @returns Complete shared links pool
 */
export function buildSharedLinksPool(responses: Map<string, string>): SharedLinksPool {
  const pool: SharedLinksPool = {};

  for (const [researcherId, response] of responses.entries()) {
    const { cited, candidates } = parseResearcherLinks(response);
    pool[researcherId] = { cited, candidates };
  }

  return pool;
}

/**
 * Get the file path for a session's shared links
 * @param sessionId Session ID (e.g., "abc123-x9k2")
 * @returns Full file path
 */
function getSharedLinksFilePath(sessionId: string): string {
  return path.join('/tmp', `research-links-${sessionId}.json`);
}

/**
 * Save shared links pool to file
 * @param sessionId Session ID
 * @param pool The shared links pool to save
 */
export function saveSharedLinks(sessionId: string, pool: SharedLinksPool): void {
  const filePath = getSharedLinksFilePath(sessionId);
  const content = JSON.stringify(pool, null, 2);
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Load shared links pool from file
 * @param sessionId Session ID
 * @returns The shared links pool, or null if file doesn't exist
 */
export function loadSharedLinks(sessionId: string): SharedLinksPool | null {
  const filePath = getSharedLinksFilePath(sessionId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as SharedLinksPool;
  } catch (error) {
    logger.error(`Failed to load shared links for session ${sessionId}:`, error);
    return null;
  }
}

/**
 * Delete shared links pool file
 * @param sessionId Session ID
 */
export function cleanupSharedLinks(sessionId: string): void {
  const filePath = getSharedLinksFilePath(sessionId);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      logger.error(`Failed to cleanup shared links for session ${sessionId}:`, error);
    }
  }
}

/**
 * Format shared links pool for inclusion in researcher prompts
 * @param pool The shared links pool
 * @returns Formatted markdown string
 */
export function formatSharedLinksForPrompt(pool: SharedLinksPool | null): string {
  if (!pool || Object.keys(pool).length === 0) {
    return '';
  }

  let output = '## Shared Links from Previous Research\n\n';
  output += 'The following links have been examined by other researchers:\n\n';

  for (const [researcherId, entry] of Object.entries(pool).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    output += `### Researcher ${researcherId}\n\n`;

    if (entry.cited.length > 0) {
      output += '### CITED LINKS\n';
      for (const link of entry.cited) {
        output += `* [${link.url}]${link.description ? ` - ${link.description}` : ''}\n`;
      }
      output += '\n';
    }

    if (entry.candidates.length > 0) {
      output += '### SCRAPE CANDIDATES\n';
      for (const candidate of entry.candidates) {
        output += `* [${candidate.url}] - Not used (${candidate.reason})\n`;
      }
      output += '\n';
    }

    if (entry.cited.length === 0 && entry.candidates.length === 0) {
      output += '*No links reported*\n\n';
    }
  }

  output += '**Use this shared pool to avoid re-scraping URLs that have already been examined.**\n';

  return output;
}

/**
 * Get a summary of the shared links pool (for coordinator context)
 * @param pool The shared links pool
 * @returns Summary string
 */
export function getSharedLinksSummary(pool: SharedLinksPool | null): string {
  if (!pool || Object.keys(pool).length === 0) {
    return 'No shared links yet';
  }

  const researcherCount = Object.keys(pool).length;
  let citedCount = 0;
  let candidateCount = 0;

  for (const entry of Object.values(pool)) {
    citedCount += entry.cited.length;
    candidateCount += entry.candidates.length;
  }

  return `${researcherCount} researcher(s), ${citedCount} cited, ${candidateCount} candidate(s)`;
}
