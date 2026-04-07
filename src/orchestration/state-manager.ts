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
      const sessionManager = (this.ctx as any).sessionManager;
      if (!sessionManager) return null;

      const entries = sessionManager.getEntries?.();
      if (!entries || !Array.isArray(entries)) return null;

      // Scan backwards for the latest state entry
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry && entry.type === ENTRY_TYPE) {
          const data = (entry as CustomEntry<SystemResearchState>).data;
          if (data) return data;
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
      const appendEntry = (this.ctx as any).appendEntry;
      if (typeof appendEntry === 'function') {
        appendEntry(ENTRY_TYPE, state);
        logger.debug(`[swarm-state] Checkpoint saved: ${state.status} (Round ${state.currentRound})`);
      }
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
      
      // Perfection: Reset any 'running' siblings to 'pending' so they are picked up again
      // This handles cases where the agent was stopped mid-research.
      for (const id in existing.aspects) {
        if (existing.aspects[id].status === 'running') {
          existing.aspects[id].status = 'pending';
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
