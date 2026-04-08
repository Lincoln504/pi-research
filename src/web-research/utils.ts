/**
 * Web Research Extension - Utilities
 *
 * Helper functions, type guards, and utilities
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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

/**
 * Set the SearXNG manager instance (called by extension on session start)
 */
export function setSearxngManager(manager: SearxngManager): void {
  searxngManager = manager;
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
 * Used when browser is closed externally (e.g., via stopChromium())
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
 * The singleton browser is managed exclusively by stopChromium() in scrapers.ts
 */
export async function cleanupAllContexts(): Promise<void> {
  const cleanupPromises: Promise<void>[] = [];

  for (const ctx of activeContexts.values()) {
    cleanupPromises.push(
      (async (): Promise<void> => {
        try {
          // Close page first, then context
          // Do NOT close browser here - it's managed by stopChromium()
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
