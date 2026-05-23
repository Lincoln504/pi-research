import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../../src/utils/circuit-breaker.ts';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should trip to OPEN after threshold failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    const action = vi.fn().mockRejectedValue(new Error('fail'));

    // First 2 failures
    await expect(cb.execute(action)).rejects.toThrow('fail');
    await expect(cb.execute(action)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('CLOSED');

    // 3rd failure trips it
    await expect(cb.execute(action)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');

    // 4th call fails fast
    await expect(cb.execute(action)).rejects.toThrow('is OPEN. Fast-failing');
    expect(action).toHaveBeenCalledTimes(3); // Action not called on 4th attempt
  });

  it('should transition to HALF_OPEN after timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    const failAction = vi.fn().mockRejectedValue(new Error('fail'));
    
    await expect(cb.execute(failAction)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');

    // Advance time past reset timeout
    vi.advanceTimersByTime(1500);

    const successAction = vi.fn().mockResolvedValue('success');
    const result = await cb.execute(successAction);

    expect(result).toBe('success');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('should transition back to OPEN if HALF_OPEN fails', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    const failAction = vi.fn().mockRejectedValue(new Error('fail'));
    
    await expect(cb.execute(failAction)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');

    // Advance time
    vi.advanceTimersByTime(1500);

    // Call fails again
    await expect(cb.execute(failAction)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');
  });

  it('should not count non-transient errors towards threshold', async () => {
    const cb = new CircuitBreaker({ 
      failureThreshold: 2, 
      isTransientError: (e: any) => e.message === 'transient'
    });
    
    const failTransient = vi.fn().mockRejectedValue(new Error('transient'));
    const failFatal = vi.fn().mockRejectedValue(new Error('fatal'));

    await expect(cb.execute(failFatal)).rejects.toThrow('fatal');
    await expect(cb.execute(failFatal)).rejects.toThrow('fatal');
    await expect(cb.execute(failFatal)).rejects.toThrow('fatal');
    
    expect(cb.getState()).toBe('CLOSED');

    await expect(cb.execute(failTransient)).rejects.toThrow('transient');
    await expect(cb.execute(failTransient)).rejects.toThrow('transient');
    
    expect(cb.getState()).toBe('OPEN');
  });
});