import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../../src/utils/circuit-breaker.ts';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // restoreAllMocks does NOT uninstall fake timers — do it explicitly so the
    // clock can't stay faked past this file.
    vi.useRealTimers();
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

  it('admits only halfOpenMaxCalls concurrent probes in HALF_OPEN, fast-failing the rest', async () => {
    // Regression: once the first caller flipped OPEN→HALF_OPEN, concurrent callers saw state !==
    // 'OPEN' and all executed against the still-down dependency. Now extra concurrent probes fast-fail.
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, halfOpenMaxCalls: 1 });
    await expect(cb.execute(vi.fn().mockRejectedValue(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');
    vi.advanceTimersByTime(1500);

    // A probe that stays pending so a second caller races it while it's in flight.
    let release!: () => void;
    const pending = new Promise<string>((res) => { release = () => res('ok'); });
    const first = cb.execute(() => pending); // admitted as the single probe (flips to HALF_OPEN)

    await expect(cb.execute(vi.fn().mockResolvedValue('x'))).rejects.toThrow('HALF_OPEN (trial in progress)');
    expect(cb.getState()).toBe('HALF_OPEN');

    release();
    await expect(first).resolves.toBe('ok');
    expect(cb.getState()).toBe('CLOSED'); // the single probe succeeded → circuit closes
  });

  it('ignores a pre-outage success settling during HALF_OPEN — only the admitted probe closes the circuit', async () => {
    // Regression: a call admitted while CLOSED that settled after the breaker tripped and
    // re-half-opened counted toward the HALF_OPEN close — closing on PRE-outage evidence
    // while the real probe was still in flight against a possibly-down dependency.
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, halfOpenMaxCalls: 1 });

    // Call A: admitted while CLOSED, stays in flight across the trip + half-open.
    let resolveA!: (v: string) => void;
    const a = cb.execute(() => new Promise<string>((res) => { resolveA = res; }));

    // Trip the breaker while A is pending.
    await expect(cb.execute(vi.fn().mockRejectedValue(new Error('fail')))).rejects.toThrow('fail');
    await expect(cb.execute(vi.fn().mockRejectedValue(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getState()).toBe('OPEN');

    // Past the reset window, call B flips to HALF_OPEN and is admitted as THE probe.
    vi.advanceTimersByTime(1500);
    let resolveB!: (v: string) => void;
    const b = cb.execute(() => new Promise<string>((res) => { resolveB = res; }));
    expect(cb.getState()).toBe('HALF_OPEN');

    // A's success predates the outage — it must not close the circuit.
    resolveA('a');
    await expect(a).resolves.toBe('a');
    expect(cb.getState()).toBe('HALF_OPEN');

    // The probe's own success is the only evidence that closes it.
    resolveB('b');
    await expect(b).resolves.toBe('b');
    expect(cb.getState()).toBe('CLOSED');
  });
});