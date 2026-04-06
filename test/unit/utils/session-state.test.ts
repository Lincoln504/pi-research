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
  registerSessionUpdate,
  getActiveSessionOrder,
  isBottomMostSession,
  refreshAllSessions,
  onSessionOrderChange,
} from '../../../src/utils/session-state.ts';

describe('utils/session-state', () => {
  let sessionId: string;

  beforeEach(() => {
    // We need to clean up any global state between tests since session-state.ts uses globals
    const sessions = getActiveSessionOrder();
    for (const id of sessions) {
      endResearchSession(id);
    }
    sessionId = startResearchSession();
  });

  it('should start a new session with unique ID', () => {
    const id1 = startResearchSession();
    const id2 = startResearchSession();
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  it('should track failures per session', () => {
    const session2 = startResearchSession();
    
    recordResearcherFailure(sessionId, '1:1');
    recordResearcherFailure(session2, '2:1');
    
    expect(getFailedResearchers(sessionId)).toEqual(['1:1']);
    expect(getFailedResearchers(session2)).toEqual(['2:1']);
  });

  it('should deduplicate failures in same session', () => {
    recordResearcherFailure(sessionId, '1:1');
    recordResearcherFailure(sessionId, '1:1');
    
    expect(getFailedResearchers(sessionId)).toHaveLength(1);
    expect(getFailedResearchers(sessionId)).toEqual(['1:1']);
  });

  it('should identify when research should stop', () => {
    recordResearcherFailure(sessionId, '1:1');
    expect(shouldStopResearch(sessionId)).toBe(false);
    
    recordResearcherFailure(sessionId, '2:1');
    expect(shouldStopResearch(sessionId)).toBe(true);
  });

  it('should return formatted stop message', () => {
    recordResearcherFailure(sessionId, '1:1');
    recordResearcherFailure(sessionId, '2:1');
    
    const message = getResearchStopMessage(sessionId);
    expect(message).toContain('Research stopped: 2 researcher(s) failed: 1:1, 2:1');
  });

  it('should cleanup session on end', () => {
    recordResearcherFailure(sessionId, '1:1');
    endResearchSession(sessionId);
    expect(getFailedResearchers(sessionId)).toHaveLength(0);
  });

  describe('Session Ordering', () => {
    it('should maintain session order (chronological)', () => {
      const s1 = startResearchSession();
      const s2 = startResearchSession();
      const s3 = startResearchSession();
      
      // Sessions are only added to the order when they register an update
      registerSessionUpdate(s1, () => {});
      registerSessionUpdate(s2, () => {});
      registerSessionUpdate(s3, () => {});
      
      const order = getActiveSessionOrder();
      expect(order).toEqual([s1, s2, s3]);
    });

    it('should correctly identify the bottom-most session (index 0)', () => {
      const s1 = startResearchSession();
      const s2 = startResearchSession();
      
      registerSessionUpdate(s1, () => {});
      registerSessionUpdate(s2, () => {});
      
      expect(isBottomMostSession(s1)).toBe(true);
      expect(isBottomMostSession(s2)).toBe(false);
    });

    it('should update bottom-most when oldest session ends', () => {
      const s1 = startResearchSession();
      const s2 = startResearchSession();
      
      registerSessionUpdate(s1, () => {});
      registerSessionUpdate(s2, () => {});
      
      expect(isBottomMostSession(s1)).toBe(true);
      
      endResearchSession(s1);
      
      expect(isBottomMostSession(s2)).toBe(true);
    });

    it('should notify order changes when sessions are added or removed', () => {
      const s1 = startResearchSession();
      const s2 = startResearchSession();
      const callback = vi.fn();
      
      onSessionOrderChange(callback);
      
      registerSessionUpdate(s1, () => {});
      expect(callback).toHaveBeenCalledTimes(1);
      
      registerSessionUpdate(s2, () => {});
      expect(callback).toHaveBeenCalledTimes(2);
      
      endResearchSession(s1);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('should debounce refreshAllSessions', async () => {
      vi.useFakeTimers();
      const s1 = startResearchSession();
      const update1 = vi.fn();
      registerSessionUpdate(s1, update1);
      
      refreshAllSessions();
      refreshAllSessions();
      refreshAllSessions();
      
      expect(update1).not.toHaveBeenCalled();
      
      vi.advanceTimersByTime(10);
      expect(update1).toHaveBeenCalledTimes(1);
      
      vi.useRealTimers();
    });

    it('should update sessions in newest-to-oldest order during refresh', async () => {
      vi.useFakeTimers();
      const s1 = startResearchSession();
      const s2 = startResearchSession();
      
      const callOrder: string[] = [];
      registerSessionUpdate(s1, () => callOrder.push('s1'));
      registerSessionUpdate(s2, () => callOrder.push('s2'));
      
      refreshAllSessions();
      vi.advanceTimersByTime(10);
      
      // activeSessionOrder = [s1, s2]
      // Loop is for (i = length - 1; i >= 0; i--)
      // So s2 then s1
      expect(callOrder).toEqual(['s2', 's1']);
      
      vi.useRealTimers();
    });
  });
});
