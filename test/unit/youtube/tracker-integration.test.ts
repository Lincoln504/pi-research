/**
 * Tests that youtube_transcript is wired into the shared gathering budget and
 * carries its own one-call-per-researcher hard cap.
 */

import { describe, it, expect } from 'vitest';
import { ToolUsageTracker, createDefaultToolLimits } from '../../../src/utils/tool-usage-tracker.ts';
import { MAX_GATHERING_CALLS } from '../../../src/constants.ts';

describe('youtube_transcript tracker integration', () => {
  it('counts toward the shared gathering budget', () => {
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    expect(tracker.getCallCount('youtube_transcript')).toBe(0);
    tracker.recordCall('youtube_transcript');
    // gathering category count is shared across search/stackexchange/grep/youtube_transcript
    expect(tracker.getCallCount('search')).toBe(1);
  });

  it('hard-caps youtube_transcript at one call per researcher', () => {
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    expect(tracker.recordCall('youtube_transcript')).toBe(true);
    expect(tracker.recordCall('youtube_transcript')).toBe(false);
    expect(tracker.getLimitMessage('youtube_transcript')).toMatch(/YOUTUBE TRANSCRIPT LIMIT REACHED/);
  });

  it('a blocked youtube_transcript call does not consume a second gathering slot', () => {
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    tracker.recordCall('youtube_transcript'); // allowed (1)
    tracker.recordCall('youtube_transcript'); // blocked, not counted
    expect(tracker.getCallCount('youtube_transcript')).toBe(1);
  });

  it('the gathering budget can still be exhausted by other tools after the youtube call', () => {
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    tracker.recordCall('youtube_transcript');
    let allowed = 0;
    for (let i = 0; i < MAX_GATHERING_CALLS + 2; i++) {
      if (tracker.recordCall('stackexchange')) allowed++;
    }
    // 1 youtube + N stackexchange == MAX_GATHERING_CALLS total
    expect(allowed).toBe(MAX_GATHERING_CALLS - 1);
  });
});
