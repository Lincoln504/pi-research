/**
 * Web Research Extension - Utilities
 *
 * Helper functions, type guards, and utilities
 */

import { createRequire } from 'module';
import type { SearXNGResult } from './types.ts';

const require = createRequire(import.meta.url);

/**
 * Filter search results based on keyword relevance to detect "junk" results
 * from search engines that are blocking the bot.
 */
export function filterRelevantResults(query: string, results: SearXNGResult[]): SearXNGResult[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (keywords.length === 0) return results;

  return results.filter((r: SearXNGResult) => {
    const text = `${r.title} ${r.content}`.toLowerCase();
    // At least one keyword must be present in title or snippet
    return keywords.some(word => text.includes(word));
  });
}

/**
 * SearXNG Manager interface
 * Provides method to retrieve the SearXNG URL
 */
interface SearxngManager {
  getSearxngUrl(): string;
}

/**
 * Browser context tracking interface
 * Contains browser, context, page objects and a unique identifier
 */
interface TrackedContext {
  browser: {
    close(): Promise<void>;
  };
  context?: {
    close(): Promise<void>;
  };
  page?: {
    close(): Promise<void>;
  };
  id: string;
}

// Manager instance (set by extension)
let searxngManager: SearxngManager | null = null;
let fallbackSearchEnabled = false;

/**
 * Set the SearXNG manager instance (called by extension on session start)
 */
export function setSearxngManager(manager: SearxngManager): void {
  searxngManager = manager;
}

/**
 * Enable or disable fallback search mode (DuckDuckGo Lite stealth)
 */
export function setFallbackSearchEnabled(enabled: boolean): void {
  fallbackSearchEnabled = enabled;
}

/**
 * Check if fallback search mode is enabled
 */
export function isFallbackSearchEnabled(): boolean {
  return fallbackSearchEnabled;
}

/**
 * Get SearXNG URL
 * Gets URL from manager instance
 */
export function getSearxngUrl(): string {
  if (!searxngManager) {
    throw new Error('SearXNG manager not initialized. Session may not have started properly.');
  }
  return searxngManager.getSearxngUrl();
}

// Active browser contexts tracking - keyed by ID for O(1) lookup
const activeContexts = new Map<string, TrackedContext>();

/**
 * Reset connection counters (Legacy stub for compatibility)
 */
export function resetConnectionCounters(): void {}

/**
 * Clear all tracked contexts without closing them
 * Used when browser is closed externally (e.g., via stopCamoufox())
 */
export function clearTrackedContexts(): void {
  activeContexts.clear();
}

/**
 * Generate unique ID for context tracking
 */
function generateContextId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Check if a Node.js module is available
 */
export function checkModule(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up all active browser contexts
 * IMPORTANT: This does NOT close the browser - only pages and contexts
 * The singleton browser is managed exclusively by stopCamoufox() in camoufox-lifecycle.ts
 */
export async function cleanupAllContexts(): Promise<void> {
  const cleanupPromises: Promise<void>[] = [];

  for (const ctx of activeContexts.values()) {
    cleanupPromises.push(
      (async (): Promise<void> => {
        try {
          // Close page first, then context
          // Do NOT close browser here - it's managed by stopCamoufox()
          if (ctx.page !== undefined) {
            await ctx.page.close().catch(() => {});
          }
          if (ctx.context !== undefined) {
            await ctx.context.close().catch(() => {});
          }
        } catch {
          // Ignore cleanup errors
        }
      })(),
    );
  }

  // Clear AFTER promises complete to prevent race condition
  await Promise.allSettled(cleanupPromises);
  activeContexts.clear();
}

/**
 * Track a browser context for cleanup
 */
export function trackContext(
  browser: { close(): Promise<void> },
  context: { close(): Promise<void> },
  page: { close(): Promise<void> },
): string {
  const id = generateContextId();
  activeContexts.set(id, { browser, context, page, id });
  return id;
}

/**
 * Untrack a browser context by ID
 */
export function untrackContextById(id: string): void {
  activeContexts.delete(id);
}

/**
 * Validate maxConcurrency
 */
export function validateMaxConcurrency(value?: number): number {
  if (value === undefined) {
    return 10; // Default
  }
  return Math.min(Math.max(1, Math.floor(value)), 20); // Clamp between 1 and 20
}

// Legacy compatibility stubs
export function incrementConnectionCount(): void {}
export function decrementConnectionCount(): void {}
export function onConnectionCountChange(_callback: any): () => void { return () => {}; }
export function getActiveConnectionCount(): number { return 0; }
