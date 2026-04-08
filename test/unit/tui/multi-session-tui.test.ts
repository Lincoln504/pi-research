/**
 * Multi-Session TUI Integration Tests
 * 
 * Verifies coordination between session state and research panel rendering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  startResearchSession, 
  registerSessionUpdate, 
  endResearchSession,
  isBottomMostSession,
  refreshAllSessions
} from '../../../src/utils/session-state.ts';
import { createInitialPanelState } from '../../../src/tui/research-panel.ts';

describe('Multi-Session TUI Coordination', () => {
  const searxngStatus = {
    state: 'active' as const,
    connectionCount: 1,
    url: 'http://localhost:8080',
    isFunctional: false,
  };


  beforeEach(() => {
    // Clear global state if possible (session-state.ts uses globals)
    // We can't easily clear the globals without exporting them or restarting the process
    // But we can at least try to end sessions we know about
  });

  it('should correctly toggle hideSearxng based on session seniority', async () => {
    vi.useFakeTimers();

    // 1. Start Session 1 (Bottom-most)
    const s1 = startResearchSession();
    const panelState1 = createInitialPanelState(s1, searxngStatus, 'model1');
    const update1 = vi.fn(() => {
      panelState1.hideSearxng = !isBottomMostSession(s1);
    });
    registerSessionUpdate(s1, update1);

    // Initial refresh
    refreshAllSessions();
    vi.advanceTimersByTime(10);
    expect(update1).toHaveBeenCalled();
    expect(panelState1.hideSearxng).toBe(false); // Should show SearXNG

    // 2. Start Session 2 (Top-most)
    const s2 = startResearchSession();
    const panelState2 = createInitialPanelState(s2, searxngStatus, 'model2');
    const update2 = vi.fn(() => {
      panelState2.hideSearxng = !isBottomMostSession(s2);
    });
    registerSessionUpdate(s2, update2);

    // Refresh after adding s2
    refreshAllSessions();
    vi.advanceTimersByTime(10);
    
    expect(update1).toHaveBeenCalled();
    expect(update2).toHaveBeenCalled();
    expect(panelState1.hideSearxng).toBe(false); // Still shows
    expect(panelState2.hideSearxng).toBe(true);  // Hidden

    // 3. End Session 1 -> Session 2 becomes bottom-most
    endResearchSession(s1);
    
    // refreshAllSessions is called inside endResearchSession in some implementations?
    // Looking at tool.ts: cleanup calls refreshAllSessions()
    // Looking at session-state.ts: endResearchSession calls notifyOrderChange()
    // notifyOrderChange() calls subscribers. In tool.ts, unsubOrder is onSessionOrderChange(() => refreshAllSessions())
    
    // So we need to simulate the subscriber in tool.ts
    refreshAllSessions();
    vi.advanceTimersByTime(10);

    expect(panelState2.hideSearxng).toBe(false); // Now shows!

    vi.useRealTimers();
  });
});
