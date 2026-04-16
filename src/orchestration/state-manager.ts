/**
 * Deep Research State Manager
 *
 * Handles reading and writing the SystemResearchState to the Pi Session Tree.
 *
 * DEPENDENCY: Requires pi-coding-agent sessionManager API:
 * - ctx.sessionManager.getEntries?() - returns session entries array
 * - ctx.sessionManager.appendCustomEntry(type, data) - adds custom entry
 *
 * These APIs may change in future pi versions. The code uses optional chaining
 * and try-catch blocks to gracefully degrade if the API is unavailable.
 */

import type { ExtensionContext, CustomEntry } from '@mariozechner/pi-coding-agent';
import type { SystemResearchState } from './deep-research-types.ts';
import { logger } from '../logger.ts';

const ENTRY_TYPE = 'pi-research-state';

export class DeepResearchStateManager {
  constructor(private ctx: ExtensionContext) {}

  /**
   * Checks if the required sessionManager API is available.
   */
  private hasSessionManagerAPI(): boolean {
    const sessionManager = (this.ctx as any).sessionManager;
    return sessionManager !== null && sessionManager !== undefined;
  }

  /**
   * Loads the most recent research state from the session history.
   * If a query is provided, scans backwards for the latest state matching that query.
   */
  load(query?: string): SystemResearchState | null {
    if (!this.hasSessionManagerAPI()) {
      logger.debug('[deep-research-state] SessionManager API not available, cannot load state');
      return null;
    }

    try {
      const sessionManager = (this.ctx as any).sessionManager;
      const entries = sessionManager.getEntries?.();
      if (!entries || !Array.isArray(entries)) return null;

      // Scan backwards for the latest state entry (optionally matching query)
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type === 'custom' && entry.customType === ENTRY_TYPE) {
          const state = (entry as CustomEntry<SystemResearchState>).data;
          if (state && (!query || state.rootQuery === query)) {
            return state;
          }
        }
      }
    } catch (err) {
      logger.error('[deep-research-state] Failed to load state from session history:', err);
    }
    return null;
  }

  /**
   * Persists the current state to the session history.
   */
  save(state: SystemResearchState): void {
    state.lastUpdated = Date.now();

    if (!this.hasSessionManagerAPI()) {
      logger.debug('[deep-research-state] SessionManager API not available, cannot save state');
      return;
    }

    try {
      (this.ctx.sessionManager as any).appendCustomEntry(ENTRY_TYPE, state);
      logger.debug(`[deep-research-state] Checkpoint saved: ${state.status} (Round ${state.currentRound})`);
    } catch (err) {
      logger.error('[deep-research-state] Failed to save state to session history:', err);
    }
  }

  /**
   * Utility: Reconstruct state or initialize a new one.
   */
  initialize(query: string, complexity: 1 | 2 | 3): SystemResearchState {
    const existing = this.load(query);
    if (existing) {
      logger.log('[deep-research-state] Resuming existing research system.');
      
      // Perfection: Reset any 'running' siblings to 'pending' so they are picked up again
      // This handles cases where the agent was stopped mid-research.
      for (const id in existing.aspects) {
        const aspect = existing.aspects[id];
        if (aspect?.status === 'running') {
          aspect.status = 'pending';
        }
      }
      
      return existing;
    }

    return {
      version: 1,
      rootQuery: query,
      complexity,
      currentRound: 1,
      status: 'planning',
      lastUpdated: Date.now(),
      initialAgenda: [],
      allScrapedLinks: [],
      aspects: {}
    };
  }
}
