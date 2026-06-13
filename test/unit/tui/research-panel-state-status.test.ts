import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInitialPanelState, addSlice, updateSliceStatus, clearAllFlashTimeouts } from '../../../src/tui/research-panel-state.ts';
import { FLASH_STATUS_DURATION_MS } from '../../../src/constants.ts';

describe('Research Panel State - Status Flashing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllFlashTimeouts();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should flash a status for a fixed duration', () => {
    const state = createInitialPanelState('session1', 'research1', 'query', 'model');
    addSlice(state, 'researcher-1', '1');
    const onUpdate = vi.fn();

    // Initial status should be undefined
    expect(state.slices.get('researcher-1')?.status).toBeUndefined();

    // Flash status 'scrape'
    updateSliceStatus(state, 'researcher-1', 'scrape', onUpdate);
    expect(state.slices.get('researcher-1')?.status).toBe('scrape');
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Advance time by half the duration
    vi.advanceTimersByTime(FLASH_STATUS_DURATION_MS / 2);
    expect(state.slices.get('researcher-1')?.status).toBe('scrape');

    // Advance time past the duration
    vi.advanceTimersByTime(FLASH_STATUS_DURATION_MS / 2 + 10);
    expect(state.slices.get('researcher-1')?.status).toBeUndefined();
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('should queue multiple status flashes', () => {
    const state = createInitialPanelState('session1', 'research1', 'query', 'model');
    addSlice(state, 'researcher-1', '1');
    const onUpdate = vi.fn();

    updateSliceStatus(state, 'researcher-1', 'scrape', onUpdate);
    updateSliceStatus(state, 'researcher-1', 'grep', onUpdate);
    updateSliceStatus(state, 'researcher-1', 'security', onUpdate);

    // Only 'scrape' should be visible initially
    expect(state.slices.get('researcher-1')?.status).toBe('scrape');
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // After first duration, should go through a gap then show 'grep'
    vi.advanceTimersByTime(FLASH_STATUS_DURATION_MS + 10);
    expect(state.slices.get('researcher-1')?.status).toBeUndefined();
    
    vi.advanceTimersByTime(200); // Past FLASH_QUEUE_GAP_MS (150ms)
    expect(state.slices.get('researcher-1')?.status).toBe('grep');

    // After second duration and gap, should show 'security'
    vi.advanceTimersByTime(FLASH_STATUS_DURATION_MS + 200);
    expect(state.slices.get('researcher-1')?.status).toBe('security');
  });

  it('should allow immediate status updates for non-researcher slices', () => {
    const state = createInitialPanelState('session1', 'research1', 'query', 'model');
    // A slice that doesn't look like a researcher (non-numeric label and not 'coord'/'eval')
    // Wait, my current implementation is quite broad. Let's test a generic slice.
    addSlice(state, 'generic', 'Generic Label');
    
    updateSliceStatus(state, 'generic', 'idle');
    expect(state.slices.get('generic')?.status).toBe('idle');

    // Should NOT clear after duration
    vi.advanceTimersByTime(FLASH_STATUS_DURATION_MS + 100);
    expect(state.slices.get('generic')?.status).toBe('idle');
  });

  it('should NOT flash status for core agents (coord/eval)', () => {
    const state = createInitialPanelState('session1', 'research1', 'query', 'model');
    addSlice(state, 'coord', 'coordinator');
    
    updateSliceStatus(state, 'coord', 'planning');
    expect(state.slices.get('coord')?.status).toBe('planning');

    // Should NOT clear after duration
    vi.advanceTimersByTime(FLASH_STATUS_DURATION_MS + 100);
    expect(state.slices.get('coord')?.status).toBe('planning');
  });
});
