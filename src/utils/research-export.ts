/**
 * Research Export Utility
 *
 * Saves research results to /tmp with a simple naming scheme.
 * Uses 2-character alphanumeric hash for filename suffix.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.ts';
import { MAX_QUERY_LENGTH, HASH_LENGTH, MAX_EXPORT_RETRIES } from '../constants.ts';

const HASH_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Sanitize query for use in filename
 */
function sanitizeQuery(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate a random 2-character hash
 */
function generateHash(): string {
  let hash = '';
  for (let i = 0; i < HASH_LENGTH; i++) {
    hash += HASH_CHARS[Math.floor(Math.random() * HASH_CHARS.length)];
  }
  return hash;
}

/**
 * Export research report to /tmp
 *
 * @param query - The research query
 * @param result - The research result content
 * @param mode - The research mode ('quick' or 'deep')
 * @returns The file path if successful, null otherwise
 */
export async function exportResearchReport(
  query: string,
  result: string,
  _mode: 'quick' | 'deep'
): Promise<string | null> {
  const sanitizedQuery = sanitizeQuery(query);
  const baseFilename = `pi-research-${sanitizedQuery}`;

  // Try up to MAX_EXPORT_RETRIES times with different hashes
  for (let attempt = 0; attempt < MAX_EXPORT_RETRIES; attempt++) {
    const hash = generateHash();
    const filename = `${baseFilename}-${hash}.md`;
    const filepath = join(tmpdir(), filename);

    try {
      // Use 'wx' flag to fail if file exists (avoid collisions)
      await fs.writeFile(filepath, result, { flag: 'wx' });
      logger.log(`[export] Research report saved to: ${filepath}`);
      return filepath;
    } catch (error) {
      // If file exists, try another hash
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      // For other errors, log and give up
      logger.error(`[export] Failed to save research report:`, error);
      return null;
    }
  }

  // If we exhausted all attempts
  logger.error(`[export] Failed to save research report after ${MAX_EXPORT_RETRIES} attempts (hash collision)`);
  return null;
}

/**
 * Append export message to research result
 */
export function appendExportMessage(result: string, filepath: string): string {
  return result + `\n\n---\n\nResearch report saved to: ${filepath}`;
}
