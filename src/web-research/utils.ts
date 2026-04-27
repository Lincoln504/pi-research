/**
 * Web Research Extension - Utilities
 *
 * Helper functions, type guards, and utilities
 */

import { createRequire } from 'module';
import type { SearchResult } from './types.ts';

const require = createRequire(import.meta.url);

/**
 * Filter search results based on keyword relevance to detect "junk" results.
 */
export function filterRelevantResults(query: string, results: SearchResult[]): SearchResult[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (keywords.length === 0) return results;

  return results.filter((r: SearchResult) => {
    const text = `${r.title} ${r.content}`.toLowerCase();
    return keywords.some(word => text.includes(word));
  });
}

/**
 * Robustly validate and cap scraping concurrency.
 */
export function validateMaxConcurrency(requested?: number): number {
  const DEFAULT = 10;
  const MAX = 20;
  if (requested === undefined) return DEFAULT;
  
  // Floor and handle NaN
  const num = Math.floor(Number(requested));
  if (isNaN(num)) return DEFAULT;
  
  return Math.min(MAX, Math.max(1, num));
}

/**
 * Common module checking utility
 */
export function checkModule(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}
