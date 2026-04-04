/**
 * Session State Unit Tests
 *
 * Tests pure functions that don't require refactoring.
 * Can run immediately with existing code.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  startResearchSession,
  endResearchSession,
  recordResearcherFailure,
  getFailedResearchers,
  shouldStopResearch,
  getResearchStopMessage,
  getCurrentSessionId,
  getAllSessions,
} from '../../src/utils/session-state';

describe('session-state', () => {
  beforeEach(() => {
    endResearchSession();
  });

  describe('startResearchSession', () => {
    it('should start a new session and return session ID', () => {
      const sessionId = startResearchSession();
      expect(sessionId).toMatch(/^research-\d+-[a-z0-9]+$/);
      expect(getCurrentSessionId()).toBe(sessionId);
    });

    it('should create empty failure list for new session', () => {
      startResearchSession();
      expect(getFailedResearchers()).toEqual([]);
    });

    it('should generate unique session IDs', () => {
      const id1 = startResearchSession();
      const id2 = startResearchSession();
      expect(id1).not.toBe(id2);
    });
  });

  describe('endResearchSession', () => {
    it('should clear current session', () => {
      const sessionId = startResearchSession();
      endResearchSession();
      expect(getCurrentSessionId()).toBeNull();
      expect(getFailedResearchers()).toEqual([]);
    });

    it('should not throw when no session is active', () => {
      expect(() => endResearchSession()).not.toThrow();
    });
  });

  describe('recordResearcherFailure', () => {
    it('should record failure for current session', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      expect(getFailedResearchers()).toEqual(['1:1']);
    });

    it('should record multiple failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('2:1');
      recordResearcherFailure('3:1');
      expect(getFailedResearchers()).toEqual(['1:1', '2:1', '3:1']);
    });

    it('should record duplicate failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('1:1');
      recordResearcherFailure('1:1');
      expect(getFailedResearchers()).toEqual(['1:1']); // Deduplicated
    });

    it('should not record when no session is active', () => {
      expect(() => recordResearcherFailure('1:1')).not.toThrow();
      expect(getFailedResearchers()).toEqual([]);
    });
  });

  describe('shouldStopResearch', () => {
    it('should return false with no failures', () => {
      startResearchSession();
      expect(shouldStopResearch()).toBe(false);
    });

    it('should return false with one failure', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      expect(shouldStopResearch()).toBe(false);
    });

    it('should return true with two unique failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('2:1');
      expect(shouldStopResearch()).toBe(true);
    });

    it('should return true with three unique failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('2:1');
      recordResearcherFailure('3:1');
      expect(shouldStopResearch()).toBe(true);
    });

    it('should deduplicate failures before checking', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('1:1');
      recordResearcherFailure('1:1');
      expect(shouldStopResearch()).toBe(false); // Only 1 unique failure
    });
  });

  describe('getResearchStopMessage', () => {
    it('should return formatted error message with failures', () => {
      startResearchSession();
      recordResearcherFailure('1:1');
      recordResearcherFailure('2:1');

      const message = getResearchStopMessage();
      expect(message).toContain('Research stopped: 2 researcher(s) failed: 1:1, 2:1');
      expect(message).toContain('Troubleshooting:');
      expect(message).toContain('Check network connection');
    });

    it('should return message with single failure', () => {
      startResearchSession();
      recordResearcherFailure('1:1');

      const message = getResearchStopMessage();
      expect(message).toContain('Research stopped: 1 researcher(s) failed: 1:1');
    });
  });

  describe('getCurrentSessionId', () => {
    it('should return null when no session is active', () => {
      expect(getCurrentSessionId()).toBeNull();
    });

    it('should return session ID when session is active', () => {
      const sessionId = startResearchSession();
      expect(getCurrentSessionId()).toBe(sessionId);
    });
  });

  describe('getAllSessions', () => {
    it('should return a map instance', () => {
      const sessions = getAllSessions();
      expect(sessions).toBeInstanceOf(Map);
    });
  });
});
