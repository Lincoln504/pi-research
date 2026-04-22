/**
 * Web Research Extension - Utilities
 *
 * Helper functions, type guards, and utilities
 */

import { createRequire } from 'module';
import type { SearXNGResult } from './types.ts';

const require = createRequire(import.meta.url);

/**
 * Filter search results based on keyword relevance to detect "junk" results.
 */
export function filterRelevantResults(query: string, results: SearXNGResult[]): SearXNGResult[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (keywords.length === 0) return results;

  return results.filter((r: SearXNGResult) => {
    const text = `${r.title} ${r.content}`.toLowerCase();
    return keywords.some(word => text.includes(word));
  });
}

/**
 * Browser Context Tracker
 * Ensures all browser pages and contexts are cleaned up during session shutdown.
 */
interface TrackedContext {
  id: string;
  browser: any;
  context: any;
  page: any;
}

const activeContexts = new Map<string, TrackedContext>();

export function trackContext(browser: any, context: any, page: any): string {
  const id = Math.random().toString(36).substring(7);
  activeContexts.set(id, { id, browser, context, page });
  return id;
}

export function untrackContextById(id: string): void {
  activeContexts.delete(id);
}

export function clearTrackedContexts(): void {
  activeContexts.clear();
}

/**
 * Clean up all active browser contexts.
 */
export async function cleanupAllContexts(): Promise<void> {
  const cleanupPromises: Promise<void>[] = [];
  for (const ctx of activeContexts.values()) {
    cleanupPromises.push(
      (async (): Promise<void> => {
        try {
          if (ctx.page !== undefined) await ctx.page.close().catch(() => {});
          if (ctx.context !== undefined) await ctx.context.close().catch(() => {});
        } catch (e) {}
      })()
    );
  }
  await Promise.all(cleanupPromises);
  activeContexts.clear();
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
