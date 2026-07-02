/**
 * Tests for the per-URL flash queue system in research-panel-state.ts.
 *
 * The flash queue provides per-URL visual feedback in the TUI: green for
 * success, red for failure.  Flashes queue up when many URLs resolve at
 * once, with a small inter-flash gap so they are visually distinct.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  flashSlice,
  clearAllFlashTimeouts,
  addSlice,
  completeSlice,
  reactivateSlice,
  clearCompletedResearchers,
  createInitialPanelState,
} from '../../../src/tui/research-panel-state.ts';
import type { ResearchPanelState } from '../../../src/types/research-panel-types.ts';

function makeState(sessionId = 'test-session', researchId = 'research-1'): ResearchPanelState {
  return createInitialPanelState(sessionId, researchId, 'test query', 'test-model');
}

describe('Flash queue system', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAllFlashTimeouts();
  });

  // =========================================================================
  // Core timing
  // =========================================================================

  it('applies correct duration for green (400ms) and red (700ms)', () => {
    const state = makeState();
    const onUpdate = vi.fn();
    addSlice(state, 'g', 'g');
    addSlice(state, 'r', 'r');

    flashSlice(state, 'g', 'green', onUpdate);
    flashSlice(state, 'r', 'red', onUpdate);

    // 1ms before green expires → still green
    vi.advanceTimersByTime(399);
    expect(state.slices.get('g')!.flash).toBe('green');
    expect(state.slices.get('r')!.flash).toBe('red');

    // Green expires at 400ms
    vi.advanceTimersByTime(1);
    expect(state.slices.get('g')!.flash).toBeNull();
    expect(state.slices.get('r')!.flash).toBe('red'); // red has 300ms left

    // Red expires at 700ms
    vi.advanceTimersByTime(300);
    expect(state.slices.get('r')!.flash).toBeNull();
  });

  // =========================================================================
  // Queue sequencing with inter-flash gaps
  // =========================================================================

  it('plays queued flashes sequentially with 150ms gaps, triggering onUpdate at each transition', () => {
    const state = makeState();
    const onUpdate = vi.fn();
    addSlice(state, '1', '1');

    // 4 flashes fire synchronously: only the first starts immediately
    flashSlice(state, '1', 'green', onUpdate);
    flashSlice(state, '1', 'red', onUpdate);
    flashSlice(state, '1', 'green', onUpdate);
    flashSlice(state, '1', 'red', onUpdate);
    expect(state.slices.get('1')!.flash).toBe('green');

    // Timeline: green(400) → gap(150) → red(700) → gap(150) → green(400) → gap(150) → red(700)
    const snapshot = () => state.slices.get('1')!.flash as string | null;

    vi.advanceTimersByTime(400);
    const atGap1 = snapshot(); // gap — null

    vi.advanceTimersByTime(150);
    const atRed1 = snapshot(); // 2nd flash — red

    vi.advanceTimersByTime(700);
    const atGap2 = snapshot(); // gap — null

    vi.advanceTimersByTime(150);
    const atGreen2 = snapshot(); // 3rd flash — green

    vi.advanceTimersByTime(400);
    const atGap3 = snapshot(); // gap — null

    vi.advanceTimersByTime(150);
    const atRed2 = snapshot(); // 4th flash — red

    vi.advanceTimersByTime(700);
    const atDone = snapshot(); // done — null

    expect([atGap1, atRed1, atGap2, atGreen2, atGap3, atRed2, atDone]).toEqual([
      null, 'red', null, 'green', null, 'red', null,
    ]);

    // onUpdate fires for each state change: initial set + each expiry + each gap-start + final
    // The exact count isn't critical — what matters is it was called during gaps (so the
    // brief "off" state is rendered). At minimum: 1 (initial) + gap1 + red1-start + red1-expiry + gap2 + ...
    expect(onUpdate.mock.calls.length).toBeGreaterThan(6);
  });

  // =========================================================================
  // Gap-period preemption guard
  // =========================================================================

  it('queues (does not drop) a flash arriving during the inter-flash gap', () => {
    const state = makeState();
    const onUpdate = vi.fn();
    addSlice(state, '1', '1');

    flashSlice(state, '1', 'green', onUpdate);
    flashSlice(state, '1', 'red', onUpdate); // queued

    // Advance past green into the 150ms gap
    vi.advanceTimersByTime(400);
    expect(state.slices.get('1')!.flash).toBeNull(); // gap

    // A third flash arrives during the gap — it must be queued, not start immediately
    flashSlice(state, '1', 'green', onUpdate);

    // After gap ends, red (the already-queued second flash) should start, not green
    vi.advanceTimersByTime(150);
    expect(state.slices.get('1')!.flash).toBe('red');

    // After red, green (the third flash) should follow
    vi.advanceTimersByTime(700 + 150);
    expect(state.slices.get('1')!.flash).toBe('green');

    vi.advanceTimersByTime(400);
    expect(state.slices.get('1')!.flash).toBeNull();
  });

  // =========================================================================
  // Lifecycle interrupts
  // =========================================================================

  it('stops all flashing when slice is completed mid-flash', () => {
    const state = makeState();
    addSlice(state, '1', '1');

    flashSlice(state, '1', 'green', vi.fn());
    flashSlice(state, '1', 'red', vi.fn()); // queued

    completeSlice(state, '1');
    expect(state.slices.get('1')!.flash).toBeNull();
    expect(state.slices.get('1')!.completed).toBe(true);

    // No further flashes fire
    vi.advanceTimersByTime(10_000);
    expect(state.slices.get('1')!.flash).toBeNull();
  });

  it('stops queued flashes when slice is completed during the inter-flash gap', () => {
    const state = makeState();
    addSlice(state, '1', '1');

    flashSlice(state, '1', 'green', vi.fn());
    flashSlice(state, '1', 'red', vi.fn()); // queued

    vi.advanceTimersByTime(400); // enter gap
    expect(state.slices.get('1')!.flash).toBeNull();

    completeSlice(state, '1');

    vi.advanceTimersByTime(10_000);
    expect(state.slices.get('1')!.flash).toBeNull();
  });

  it('clears flash timers when slice is reactivated', () => {
    const state = makeState();
    addSlice(state, '1', '1');

    flashSlice(state, '1', 'green', vi.fn());
    flashSlice(state, '1', 'red', vi.fn()); // queued

    reactivateSlice(state, '1');
    expect(state.slices.get('1')!.flash).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(state.slices.get('1')!.flash).toBeNull();
  });

  it('clears flash timers when addSlice overwrites an existing slice id', () => {
    const state = makeState();
    addSlice(state, 'eval', 'eval');

    flashSlice(state, 'eval', 'green', vi.fn());
    flashSlice(state, 'eval', 'red', vi.fn()); // queued

    // Re-add same id (eval re-created across evaluation rounds)
    addSlice(state, 'eval', 'eval');

    vi.advanceTimersByTime(10_000);
    expect(state.slices.get('eval')!.flash).toBeNull();
  });

  // =========================================================================
  // clearCompletedResearchers with active flash state
  // =========================================================================

  it('cleans up flash state when clearing completed researchers that had active flashes', () => {
    const state = makeState();
    addSlice(state, '1', '1');

    // Start a flash, then complete the slice (which clears flash state)
    flashSlice(state, '1', 'green', vi.fn());
    completeSlice(state, '1');

    // Now a new flash attempt on the completed slice must be a no-op
    const onUpdate = vi.fn();
    flashSlice(state, '1', 'red', onUpdate);
    expect(state.slices.get('1')!.flash).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();

    // clearCompletedResearchers removes it entirely
    clearCompletedResearchers(state);
    expect(state.slices.has('1')).toBe(false);
  });

  // =========================================================================
  // Run isolation (flash state is keyed by researchId, not pi sessionId)
  // =========================================================================

  it('isolates flash state between runs and only clears the targeted one', () => {
    const s1 = makeState('session', 'run-A');
    const s2 = makeState('session', 'run-B');
    const u1 = vi.fn();
    const u2 = vi.fn();

    addSlice(s1, '1', '1');
    addSlice(s2, '1', '1');

    flashSlice(s1, '1', 'green', u1);
    flashSlice(s2, '1', 'red', u2);

    // Clear run-A only
    clearAllFlashTimeouts('run-A');

    // run-B still has its timer running
    expect(s2.slices.get('1')!.flash).toBe('red');

    vi.advanceTimersByTime(700);
    expect(s2.slices.get('1')!.flash).toBeNull(); // run-B's red expired normally
  });

  it('isolates concurrent runs that share one pi session and reuse the same slice ids', () => {
    // Regression: two research runs in the SAME pi session both use slice ids like
    // 'coord'/'eval'/'1'. When flash state was keyed by sessionId, run B's flash
    // rendered against run A's column, and A's teardown cancelled B's timers —
    // sometimes leaving a column stuck colored. Keying by researchId isolates them.
    const runA = makeState('pi-session', 'run-A');
    const runB = makeState('pi-session', 'run-B');
    addSlice(runA, '1', '1');
    addSlice(runB, '1', '1');

    flashSlice(runA, '1', 'green', vi.fn()); // 400ms
    flashSlice(runB, '1', 'red', vi.fn());   // 700ms

    // Each run shows its OWN color despite identical slice id + shared session.
    expect(runA.slices.get('1')!.flash).toBe('green');
    expect(runB.slices.get('1')!.flash).toBe('red');

    // Run A finishing (dispose clears by researchId) must NOT cancel run B's flash.
    clearAllFlashTimeouts('run-A');
    expect(runB.slices.get('1')!.flash).toBe('red');

    // Run B's red still expires on its own 700ms schedule, unaffected by A's teardown.
    vi.advanceTimersByTime(700);
    expect(runB.slices.get('1')!.flash).toBeNull();
  });

  it('does not let one run\'s completeSlice cancel a concurrent run\'s live flash on the same id', () => {
    // completeSlice(runA, 'eval') calls clearSliceFlash(runA.researchId, 'eval');
    // if that were keyed by session it would wipe runB's 'eval' flash too.
    const runA = makeState('pi-session', 'run-A');
    const runB = makeState('pi-session', 'run-B');
    addSlice(runA, 'eval', 'eval');
    addSlice(runB, 'eval', 'eval');

    flashSlice(runB, 'eval', 'green', vi.fn());
    expect(runB.slices.get('eval')!.flash).toBe('green');

    completeSlice(runA, 'eval'); // run A's eval completes

    // run B's eval flash is untouched and expires on schedule.
    expect(runB.slices.get('eval')!.flash).toBe('green');
    vi.advanceTimersByTime(400);
    expect(runB.slices.get('eval')!.flash).toBeNull();
  });

  // =========================================================================
  // Queue cap
  // =========================================================================

  it('caps the flash queue and silently drops excess entries', () => {
    const state = makeState();
    const onUpdate = vi.fn();
    addSlice(state, '1', '1');

    // First flash starts immediately, then flood with 12 more (cap is 8 queued)
    flashSlice(state, '1', 'green', onUpdate);
    for (let i = 0; i < 12; i++) {
      flashSlice(state, '1', 'red', onUpdate);
    }

    // Walk through the full timeline and count distinct flash appearances.
    // Expected: 1 green (400ms) + 8 red (700ms each) + 8 gaps (150ms each) = 9 flashes
    const transitions: Array<string | null> = [];

    // 1 green + 8 red with gaps = 400 + 8*(700+150) = 400 + 6800 = 7200ms total
    vi.advanceTimersByTime(400); // green expires → gap
    transitions.push(state.slices.get('1')!.flash ?? null);

    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(150); // gap → red starts
      transitions.push(state.slices.get('1')!.flash ?? null);
      vi.advanceTimersByTime(700); // red expires → gap (or done)
      transitions.push(state.slices.get('1')!.flash ?? null);
    }

    // All transitions: gap, red, gap, red, ..., gap, null
    // Should be exactly: null, red, null, red, null, red, null, red,
    //                     null, red, null, red, null, red, null, red, null
    expect(transitions).toEqual([
      null, 'red', null, 'red', null, 'red', null, 'red',
      null, 'red', null, 'red', null, 'red', null, 'red', null,
    ]);

    // No more flashes after the queue drains
    vi.advanceTimersByTime(10_000);
    expect(state.slices.get('1')!.flash).toBeNull();
  });

  // =========================================================================
  // Multiple researchers in parallel
  // =========================================================================

  it('flashes multiple researchers independently without cross-contamination', () => {
    const state = makeState();
    addSlice(state, 'a', 'a');
    addSlice(state, 'b', 'b');

    flashSlice(state, 'a', 'green', vi.fn());
    flashSlice(state, 'b', 'red', vi.fn());
    // Queue a second flash on each
    flashSlice(state, 'a', 'red', vi.fn());
    flashSlice(state, 'b', 'green', vi.fn());

    // At t=0: a=green, b=red
    expect(state.slices.get('a')!.flash).toBe('green');
    expect(state.slices.get('b')!.flash).toBe('red');

    // t=400: a's green expires → gap. b's red still active (300ms left)
    vi.advanceTimersByTime(400);
    expect(state.slices.get('a')!.flash).toBeNull(); // gap
    expect(state.slices.get('b')!.flash).toBe('red');

    // t=550: a's gap ends → a starts red. b still red (150ms left)
    vi.advanceTimersByTime(150);
    expect(state.slices.get('a')!.flash).toBe('red');
    expect(state.slices.get('b')!.flash).toBe('red');

    // t=700: b's red expires → b enters gap. a's red still active (550ms left)
    vi.advanceTimersByTime(150);
    expect(state.slices.get('a')!.flash).toBe('red');
    expect(state.slices.get('b')!.flash).toBeNull(); // gap

    // t=850: b's gap ends → b starts green. a's red still active (400ms left)
    vi.advanceTimersByTime(150);
    expect(state.slices.get('a')!.flash).toBe('red');
    expect(state.slices.get('b')!.flash).toBe('green');

    // Both expire at t=1250: a's red (550+700=1250), b's green (850+400=1250)
    vi.advanceTimersByTime(400);
    expect(state.slices.get('a')!.flash).toBeNull();
    expect(state.slices.get('b')!.flash).toBeNull();
  });

  // =========================================================================
  // Guard clauses — completed, queued, nonexistent slices
  // =========================================================================

  it('ignores flash on completed, queued, and nonexistent slices', () => {
    const state = makeState();
    const onUpdate = vi.fn();

    // Completed
    addSlice(state, '1', '1');
    completeSlice(state, '1');
    flashSlice(state, '1', 'green', onUpdate);

    // Queued
    addSlice(state, '2', '2', true);
    flashSlice(state, '2', 'green', onUpdate);

    // Nonexistent
    flashSlice(state, 'nope', 'green', onUpdate);

    expect(state.slices.get('1')!.flash).toBeNull();
    expect(state.slices.get('2')!.flash).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Multiple scrape batches in the same researcher
  // =========================================================================

  it('handles flashes across multiple sequential scrape batches', () => {
    const state = makeState();
    const onUpdate = vi.fn();
    addSlice(state, '1', '1');

    // Batch 1: 2 URLs
    flashSlice(state, '1', 'green', onUpdate);
    flashSlice(state, '1', 'green', onUpdate);

    // Drain: green(400) + gap(150) + green(400)
    vi.advanceTimersByTime(400 + 150 + 400);
    expect(state.slices.get('1')!.flash).toBeNull();

    // Batch 2: 3 URLs — a second scrape call in the same researcher
    flashSlice(state, '1', 'green', onUpdate);
    flashSlice(state, '1', 'red', onUpdate);
    flashSlice(state, '1', 'green', onUpdate);

    expect(state.slices.get('1')!.flash).toBe('green');

    vi.advanceTimersByTime(400 + 150 + 700 + 150 + 400);
    expect(state.slices.get('1')!.flash).toBeNull();

    // Batch 3: 1 URL — flashes still work after many rounds
    flashSlice(state, '1', 'green', onUpdate);
    expect(state.slices.get('1')!.flash).toBe('green');

    vi.advanceTimersByTime(400);
    expect(state.slices.get('1')!.flash).toBeNull();
  });
});
