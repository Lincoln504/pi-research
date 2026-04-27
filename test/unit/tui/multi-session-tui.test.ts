/**
 * Multi-Session TUI Integration Tests
 * 
 * Verifies coordination between session state and research panel rendering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  startResearchSession, 
  registerSessionPanel,
  registerMasterUpdate,
  endResearchSession,
  refreshAllSessions,
  getPiActivePanels,
  resetAllPiSessions
} from '../../../src/utils/session-state.ts';
import { createInitialPanelState } from '../../../src/tui/research-panel.ts';

describe('Multi-Session TUI Coordination', () => {

  beforeEach(() => {
    resetAllPiSessions();
  });

  it('should correctly maintain session seniority and ordering in Master Widget', async () => {
    vi.useFakeTimers();
    const piSessionId = 'test-pi-session';
    const masterUpdate = vi.fn();
    registerMasterUpdate(piSessionId, masterUpdate);

    // 1. Start Session 1 (Bottom-most)
    const s1 = startResearchSession(piSessionId);
    const panelState1 = createInitialPanelState(s1, 'query1', 'model1');
    registerSessionPanel(piSessionId, s1, panelState1);

    // Initial refresh
    refreshAllSessions(piSessionId);
    vi.advanceTimersByTime(10);
    expect(masterUpdate).toHaveBeenCalledTimes(1);
    
    let activePanels = getPiActivePanels(piSessionId);
    expect(activePanels).toHaveLength(1);
    expect(activePanels[0]).toBe(panelState1);

    // 2. Start Session 2 (Top-most)
    const s2 = startResearchSession(piSessionId);
    const panelState2 = createInitialPanelState(s2, 'query2', 'model2');
    registerSessionPanel(piSessionId, s2, panelState2);

    // Refresh after adding s2
    refreshAllSessions(piSessionId);
    vi.advanceTimersByTime(10);
    
    expect(masterUpdate).toHaveBeenCalledTimes(2);
    
    activePanels = getPiActivePanels(piSessionId);
    expect(activePanels).toHaveLength(2);
    // getPiActivePanels returns newest first (reverse chronological)
    expect(activePanels[0]).toBe(panelState2); // Newest
    expect(activePanels[1]).toBe(panelState1); // Oldest

    // 3. End Session 1 -> Session 2 becomes only active session
    endResearchSession(piSessionId, s1);
    
    refreshAllSessions(piSessionId);
    vi.advanceTimersByTime(10);

    activePanels = getPiActivePanels(piSessionId);
    expect(activePanels).toHaveLength(1);
    expect(activePanels[0]).toBe(panelState2);

    vi.useRealTimers();
  });
});
