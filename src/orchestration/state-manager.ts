/**
 * Deep Research State Manager
 *
 * Handles reading and writing the SystemResearchState to the Pi Session Tree.
 *
 * DEPENDENCY: Requires pi-coding-agent sessionManager API:
 * - ctx.sessionManager.getEntries?() - returns state history
 * - ctx.sessionManager.addEntry?() - adds new state entry
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { SystemResearchState } from './deep-research-types.ts';
import { logger } from '../logger.ts';

const STATE_TYPE = 'custom';
const CUSTOM_TYPE = 'pi-research-state';

export class DeepResearchStateManager {
  constructor(private ctx: ExtensionContext) {}

  /**
   * Load state for a given query from session history
   */
  load(query: string): SystemResearchState | null {
    const sm = (this.ctx as any).sessionManager;
    if (!sm || typeof sm.getEntries !== 'function') return null;

    const entries = sm.getEntries();
    // Find latest state entry for this specific root query
    const stateEntry = [...entries].reverse().find((e: any) => 
      e.type === STATE_TYPE && 
      e.customType === CUSTOM_TYPE && 
      e.data?.rootQuery === query
    );

    return stateEntry ? (stateEntry.data as SystemResearchState) : null;
  }

  /**
   * Persist state to session history
   */
  save(state: SystemResearchState): void {
    const sm = (this.ctx as any).sessionManager;
    if (!sm || typeof sm.addEntry !== 'function') return;

    sm.addEntry({
      type: STATE_TYPE,
      customType: CUSTOM_TYPE,
      data: state,
      timestamp: Date.now()
    });
  }

  /**
   * Utility: Reconstruct state or initialize a new one.
   */
  initialize(query: string, complexity: 1 | 2 | 3 | 4): SystemResearchState {
    const existing = this.load(query);
    if (existing) {
      logger.log('[deep-research-state] Resuming existing research system.');
      
      // Perfection: Reset any 'running' siblings to 'pending' so they are picked up again.
      // Crucial for robustness after a crash or manual interrupt.
      Object.values(existing.aspects).forEach(a => {
        if (a.status === 'running') {
          a.status = 'pending';
        }
      });
      existing.status = 'researching'; 
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
