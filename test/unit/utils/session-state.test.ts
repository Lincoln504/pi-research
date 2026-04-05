/**
 * Session State Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  startResearchSession,
  endResearchSession,
  recordResearcherFailure,
  getFailedResearchers,
  shouldStopResearch,
  getResearchStopMessage,
} from '../../../src/utils/session-state.ts';

describe('utils/session-state', () => {
  let sessionId: string;

  beforeEach(() => {
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
});
