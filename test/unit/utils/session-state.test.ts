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
  registerSessionAbort,
  abortAllSessions,
  addSteeringMessage,
  consumeQueuedMessages,
  getSteeringMessages,
  getActiveResearchRunCount,
} from '../../../src/orchestration/session-state.ts';
import { createInitialPanelState } from '../../../src/tui/research-panel.ts';

describe('utils/session-state', () => {
  const piSessionId = 'test-pi-session';
  let sessionId: string;

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
    expect(message).toContain('Research stopped: 2 researcher(s) did not return a usable report: 1:1, 2:1');
    // Must lead with the model-layer cause, not a misleading "infrastructure / search
    // engine blocking" headline (the repeated misdiagnosis this reword fixes).
    expect(message).toContain('research model could not produce grounded results');
    expect(message).not.toContain('infrastructure failure');
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
      const p1 = createInitialPanelState(s1, 'r1', 'query', 'm');
      const p2 = createInitialPanelState(s2, 'r2', 'query', 'm');
      const p3 = createInitialPanelState(s3, 'r3', 'query', 'm');
      
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
      
      const p1 = createInitialPanelState(s1, 'r1', 'query', 'm');
      const p2 = createInitialPanelState(s2, 'r2', 'query', 'm');
      
      registerSessionPanel(psid, s1, p1);
      registerSessionPanel(psid, s2, p2);
      
      expect(isBottomMostSession(psid, s1)).toBe(true);
      expect(isBottomMostSession(psid, s2)).toBe(false);
    });

    it('should update bottom-most when oldest session ends', () => {
      const psid = 'bottom-end-test';
      const s1 = startResearchSession(psid);
      const s2 = startResearchSession(psid);
      
      const p1 = createInitialPanelState(s1, 'r1', 'query', 'm');
      const p2 = createInitialPanelState(s2, 'r2', 'query', 'm');
      
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
      
      const p1 = createInitialPanelState(s1, 'r1', 'query', 'm');
      const p2 = createInitialPanelState(s2, 'r2', 'query', 'm');
      
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
      
      const p1 = createInitialPanelState(s1, 'r1', 'query', 'm');
      registerSessionPanel(psid, s1, p1);
      
      refreshAllSessions(psid);
      refreshAllSessions(psid);
      refreshAllSessions(psid);
      
      expect(masterUpdate).not.toHaveBeenCalled();
      
      vi.advanceTimersByTime(200);
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
      
      const p1 = createInitialPanelState(s1, 'r1', 'query', 'm');
      const p2 = createInitialPanelState(s2, 'r2', 'query', 'm');
      
      registerSessionPanel(ps1, s1, p1);
      registerSessionPanel(ps2, s2, p2);
      
      expect(isBottomMostSession(ps1, s1)).toBe(true);
      expect(isBottomMostSession(ps2, s2)).toBe(true); 
      
      refreshAllSessions(ps1);
      vi.advanceTimersByTime(200);
      
      expect(masterUpdate1).toHaveBeenCalled();
      expect(masterUpdate2).not.toHaveBeenCalled(); 
      
      vi.useRealTimers();
    });
  });

  describe('registerSessionAbort / abortAllSessions', () => {
    it('abortAllSessions calls abort on all registered controllers for that Pi session', () => {
      const c1 = new AbortController();
      const c2 = new AbortController();
      registerSessionAbort(piSessionId, 'r1', c1);
      registerSessionAbort(piSessionId, 'r2', c2);

      abortAllSessions(piSessionId);

      expect(c1.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(true);
    });

    it('abortAllSessions does not affect controllers in other Pi sessions', () => {
      const other = 'other-pi-session';
      const s2 = startResearchSession(other);
      void s2;
      const c1 = new AbortController();
      const c2 = new AbortController();
      registerSessionAbort(piSessionId, 'r1', c1);
      registerSessionAbort(other, 'r2', c2);

      abortAllSessions(piSessionId);

      expect(c1.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(false);
    });

    it('abortAllSessions is a no-op for unknown Pi session', () => {
      expect(() => abortAllSessions('nonexistent-pi-session')).not.toThrow();
    });
  });

  describe('Steering message run-scoping (endResearchSession)', () => {
    it('drops an already-consumed (active) steering message when the run that consumed it ends, so a later unrelated run in the same Pi session does not inherit it', () => {
      const psid = 'steering-leak-test';
      const runA = startResearchSession(psid);
      const panelA = createInitialPanelState(runA, 'rA', 'topic A', 'model');
      registerSessionPanel(psid, runA, panelA);

      // Steer run A mid-flight; the orchestrator consumes it (queued -> active)
      // before run A finishes.
      addSteeringMessage(psid, 'focus on topic A specifics');
      const consumed = consumeQueuedMessages(psid);
      expect(consumed).toHaveLength(1);
      expect(consumed[0]!.status).toBe('active');

      // Run A finishes. The consumed message must not survive past it.
      endResearchSession(psid, runA);

      // A later, unrelated run starts in the SAME Pi session.
      const runB = startResearchSession(psid);
      const panelB = createInitialPanelState(runB, 'rB', 'topic B', 'model');
      registerSessionPanel(psid, runB, panelB);

      const steeringForB = getSteeringMessages(psid);
      expect(steeringForB.map(m => m.text)).not.toContain('focus on topic A specifics');
      expect(steeringForB).toHaveLength(0);
    });

    it('preserves a genuinely still-queued (never-consumed) steering message across endResearchSession so the next run in the same Pi session can see it', () => {
      const psid = 'steering-gap-preserve-test';
      const runA = startResearchSession(psid);
      const panelA = createInitialPanelState(runA, 'rA', 'topic A', 'model');
      registerSessionPanel(psid, runA, panelA);

      // Message arrives but is never consumed before run A ends (e.g. it arrived
      // in the gap right at/after run completion).
      addSteeringMessage(psid, 'arrived in the gap, unconsumed');

      endResearchSession(psid, runA);

      const runB = startResearchSession(psid);
      const panelB = createInitialPanelState(runB, 'rB', 'topic B', 'model');
      registerSessionPanel(psid, runB, panelB);

      const steeringForB = getSteeringMessages(psid);
      expect(steeringForB.map(m => m.text)).toContain('arrived in the gap, unconsumed');
    });

    it('does NOT treat ending one of several concurrent HEADLESS runs as the last run (order/panels are TUI-only and always empty for headless)', () => {
      // Regression: the last-run gate used to be `order.length === 0 &&
      // panels.size === 0` alone — both populated ONLY by the TUI path — so
      // for a purely headless multi-run session this was trivially true on
      // EVERY single run's end, treating each one as "the last," even with
      // siblings still genuinely active. That cleared `aborts` for still-
      // running siblings (corrupting getActiveResearchRunCount for any
      // caller) and could wipe steering a genuinely-still-running sibling
      // still needed. `aborts.size === 0` closes it.
      const psid = 'headless-multi-run-test';
      const runA = startResearchSession(psid);
      const runB = startResearchSession(psid);
      const cA = new AbortController();
      const cB = new AbortController();
      registerSessionAbort(psid, runA, cA);
      registerSessionAbort(psid, runB, cB);

      expect(getActiveResearchRunCount(psid)).toBe(2);

      // Run A ends while run B is still active.
      endResearchSession(psid, runA);

      // B must still be counted as active — A's end must not have been
      // mistaken for "the last run in the session."
      expect(getActiveResearchRunCount(psid)).toBe(1);
      // B's own abort controller must survive — a premature `aborts.clear()`
      // here would silently strand it, breaking abortAllSessions for B.
      expect(cB.signal.aborted).toBe(false);
    });

    it('preserves an unconsumed steering message across a headless run ending while a SIBLING headless run is still active, and does not touch it again on the sibling’s own end', () => {
      // Reproduces the exact regression an adversarial review found in an
      // earlier version of this fix: a steering message present when the
      // (mistakenly-detected-as-last) run ended got preserved by the
      // preserve-branch, but a SEPARATE caller-side check (since removed)
      // immediately wiped it right after, because it read the freshly-
      // cleared `aborts` as "count 0 → nobody left → safe to clear." With
      // the gate now requiring `aborts.size === 0` itself, and with no
      // second clear-call left anywhere, the preserve-branch simply does
      // not fire at all until the TRUE last run ends.
      const psid = 'headless-preserve-vs-sibling-test';
      const runA = startResearchSession(psid);
      const runB = startResearchSession(psid);
      registerSessionAbort(psid, runA, new AbortController());
      registerSessionAbort(psid, runB, new AbortController());

      addSteeringMessage(psid, 'meant for whichever run reads it next');

      // A ends first; B is still active, so this must NOT be treated as the
      // last run — the message must survive untouched.
      endResearchSession(psid, runA);
      expect(getSteeringMessages(psid).map(m => m.text)).toContain('meant for whichever run reads it next');

      // Now B ends too — genuinely the last run. The preserve-filter runs
      // exactly once, here, and the still-queued message survives into a
      // following run C.
      endResearchSession(psid, runB);
      expect(getActiveResearchRunCount(psid)).toBe(0);

      const runC = startResearchSession(psid);
      void runC;
      expect(getSteeringMessages(psid).map(m => m.text)).toContain('meant for whichever run reads it next');
    });
  });
});
