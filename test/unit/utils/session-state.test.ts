/**
 * Session State Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startResearchSession,
  endResearchSession,
  recordResearcherFailure,
  getFailedResearchers,
  shouldStopResearch,
  getResearchStopMessage,
  registerSessionPanel,
  getPiActiveSessionOrder,
  isBottomMostSession,
  refreshAllSessions,
  onSessionOrderChange,
  resetAllPiSessions,
  registerMasterUpdate,
} from '../../../src/utils/session-state.ts';
import { createInitialPanelState } from '../../../src/tui/research-panel.ts';

describe('utils/session-state', () => {
  const piSessionId = 'test-pi-session';
  let sessionId: string;
  const searxngStatus = { state: 'active' as const, url: 'http://localhost', isFunctional: true };

  beforeEach(() => {
    resetAllPiSessions();
    sessionId = startResearchSession(piSessionId);
  });

  it('should start a new session with unique ID', () => {
    const id1 = startResearchSession(piSessionId);
    const id2 = startResearchSession(piSessionId);
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  it('should track failures per session', () => {
    const session2 = startResearchSession(piSessionId);
    
    recordResearcherFailure(piSessionId, sessionId, '1:1');
    recordResearcherFailure(piSessionId, session2, '2:1');
    
    expect(getFailedResearchers(piSessionId, sessionId)).toEqual(['1:1']);
    expect(getFailedResearchers(piSessionId, session2)).toEqual(['2:1']);
  });

  it('should deduplicate failures in same session', () => {
    recordResearcherFailure(piSessionId, sessionId, '1:1');
    recordResearcherFailure(piSessionId, sessionId, '1:1');
    
    expect(getFailedResearchers(piSessionId, sessionId)).toHaveLength(1);
    expect(getFailedResearchers(piSessionId, sessionId)).toEqual(['1:1']);
  });

  it('should identify when research should stop', () => {
    recordResearcherFailure(piSessionId, sessionId, '1:1');
    expect(shouldStopResearch(piSessionId, sessionId)).toBe(false);
    
    recordResearcherFailure(piSessionId, sessionId, '2:1');
    expect(shouldStopResearch(piSessionId, sessionId)).toBe(true);
  });

  it('should return formatted stop message', () => {
    recordResearcherFailure(piSessionId, sessionId, '1:1');
    recordResearcherFailure(piSessionId, sessionId, '2:1');
    
    const message = getResearchStopMessage(piSessionId, sessionId);
    expect(message).toContain('Research stopped: 2 researcher(s) failed: 1:1, 2:1');
  });

  it('should cleanup session on end', () => {
    recordResearcherFailure(piSessionId, sessionId, '1:1');
    endResearchSession(piSessionId, sessionId);
    expect(getFailedResearchers(piSessionId, sessionId)).toHaveLength(0);
  });

  describe('Session Ordering', () => {
    it('should maintain session order (chronological)', () => {
      const psid = 'order-test';
      const s1 = startResearchSession(psid);
      const s2 = startResearchSession(psid);
      const s3 = startResearchSession(psid);
      
      // Sessions are only added to the order when they register a panel
      const p1 = createInitialPanelState(s1, 'query', searxngStatus, 'm');
      const p2 = createInitialPanelState(s2, 'query', searxngStatus, 'm');
      const p3 = createInitialPanelState(s3, 'query', searxngStatus, 'm');
      
      registerSessionPanel(psid, s1, p1);
      registerSessionPanel(psid, s2, p2);
      registerSessionPanel(psid, s3, p3);
      
      const order = getPiActiveSessionOrder(psid);
      expect(order).toEqual([s1, s2, s3]);
    });

    it('should correctly identify the bottom-most session (index 0)', () => {
      const psid = 'bottom-test';
      const s1 = startResearchSession(psid);
      const s2 = startResearchSession(psid);
      
      const p1 = createInitialPanelState(s1, 'query', searxngStatus, 'm');
      const p2 = createInitialPanelState(s2, 'query', searxngStatus, 'm');
      
      registerSessionPanel(psid, s1, p1);
      registerSessionPanel(psid, s2, p2);
      
      expect(isBottomMostSession(psid, s1)).toBe(true);
      expect(isBottomMostSession(psid, s2)).toBe(false);
    });

    it('should update bottom-most when oldest session ends', () => {
      const psid = 'bottom-end-test';
      const s1 = startResearchSession(psid);
      const s2 = startResearchSession(psid);
      
      const p1 = createInitialPanelState(s1, 'query', searxngStatus, 'm');
      const p2 = createInitialPanelState(s2, 'query', searxngStatus, 'm');
      
      registerSessionPanel(psid, s1, p1);
      registerSessionPanel(psid, s2, p2);
      
      expect(isBottomMostSession(psid, s1)).toBe(true);
      
      endResearchSession(psid, s1);
      
      expect(isBottomMostSession(psid, s2)).toBe(true);
    });

    it('should notify order changes when sessions are added or removed', () => {
      const psid = 'notify-test';
      const s1 = startResearchSession(psid);
      const s2 = startResearchSession(psid);
      const callback = vi.fn();
      
      onSessionOrderChange(psid, callback);
      
      const p1 = createInitialPanelState(s1, 'query', searxngStatus, 'm');
      const p2 = createInitialPanelState(s2, 'query', searxngStatus, 'm');
      
      registerSessionPanel(psid, s1, p1);
      expect(callback).toHaveBeenCalledTimes(1);
      
      registerSessionPanel(psid, s2, p2);
      expect(callback).toHaveBeenCalledTimes(2);
      
      endResearchSession(psid, s1);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('should debounce refreshAllSessions and call master update', async () => {
      vi.useFakeTimers();
      const psid = 'debounce-test';
      const s1 = startResearchSession(psid);
      const masterUpdate = vi.fn();
      registerMasterUpdate(psid, masterUpdate);
      
      const p1 = createInitialPanelState(s1, 'query', searxngStatus, 'm');
      registerSessionPanel(psid, s1, p1);
      
      refreshAllSessions(psid);
      refreshAllSessions(psid);
      refreshAllSessions(psid);
      
      expect(masterUpdate).not.toHaveBeenCalled();
      
      vi.advanceTimersByTime(10);
      expect(masterUpdate).toHaveBeenCalledTimes(1);
      
      vi.useRealTimers();
    });

    it('should not interfere between different Pi sessions', async () => {
      vi.useFakeTimers();
      const ps1 = 'pi-1';
      const ps2 = 'pi-2';
      
      const s1 = startResearchSession(ps1);
      const s2 = startResearchSession(ps2);
      
      const masterUpdate1 = vi.fn();
      const masterUpdate2 = vi.fn();
      
      registerMasterUpdate(ps1, masterUpdate1);
      registerMasterUpdate(ps2, masterUpdate2);
      
      const p1 = createInitialPanelState(s1, 'query', searxngStatus, 'm');
      const p2 = createInitialPanelState(s2, 'query', searxngStatus, 'm');
      
      registerSessionPanel(ps1, s1, p1);
      registerSessionPanel(ps2, s2, p2);
      
      expect(isBottomMostSession(ps1, s1)).toBe(true);
      expect(isBottomMostSession(ps2, s2)).toBe(true); 
      
      refreshAllSessions(ps1);
      vi.advanceTimersByTime(10);
      
      expect(masterUpdate1).toHaveBeenCalled();
      expect(masterUpdate2).not.toHaveBeenCalled(); 
      
      vi.useRealTimers();
    });
  });
});
