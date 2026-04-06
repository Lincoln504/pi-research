/**
 * Swarm State Manager
 * 
 * Handles reading and writing the SystemResearchState to the Pi Session Tree.
 */

import type { ExtensionContext, CustomEntry } from '@mariozechner/pi-coding-agent';
import type { SystemResearchState } from './swarm-types.ts';
import { logger } from '../logger.ts';

const ENTRY_TYPE = 'pi-research-state';

export class SwarmStateManager {
  constructor(private ctx: ExtensionContext) {}

  /**
   * Loads the most recent research state from the session history.
   */
  load(): SystemResearchState | null {
    try {
      const entries = this.ctx.sessionManager.getEntries();
      // Scan backwards for the latest state entry
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === ENTRY_TYPE) {
          return (entry as CustomEntry<SystemResearchState>).data;
        }
      }
    } catch (err) {
      logger.error('[swarm-state] Failed to load state from session history:', err);
    }
    return null;
  }

  /**
   * Persists the current state to the session history.
   */
  save(state: SystemResearchState): void {
    state.lastUpdated = Date.now();
    try {
      this.ctx.appendEntry(ENTRY_TYPE, state);
      logger.debug(`[swarm-state] Checkpoint saved: ${state.status} (Round ${state.currentRound})`);
    } catch (err) {
      logger.error('[swarm-state] Failed to save state to session history:', err);
    }
  }

  /**
   * Utility: Reconstruct state or initialize a new one.
   */
  initialize(query: string, complexity: 1 | 2 | 3): SystemResearchState {
    const existing = this.load();
    if (existing && existing.rootQuery === query) {
      logger.log('[swarm-state] Resuming existing research system.');
      return existing;
    }

    return {
      version: 1,
      rootQuery: query,
      complexity,
      currentRound: 1,
      status: 'planning',
      lastUpdated: Date.now(),
      allScrapedLinks: [],
      aspects: {}
    };
  }
}
