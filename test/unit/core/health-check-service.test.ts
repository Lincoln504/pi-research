import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthCheckService } from '../../../src/core/health-check-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';

describe('HealthCheckService', () => {
  let service: HealthCheckService;

  beforeEach(() => {
    service = new HealthCheckService({
      backoffBaseMs: 100,
      backoffMaxMs: 1000,
      backoffMultiplier: 2,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with default state', async () => {
    await service.initialize();
    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    expect(service.getFailureCount()).toBe(0);
    expect(service.getPendingCheck()).toBeNull();
    expect(service.isBackoffActive()).toBe(false);
  });

  it('should coordinate pending checks (thundering herd prevention)', () => {
    const mockResult: any = { ok: true };
    const promise = Promise.resolve(mockResult);
    
    service.setPendingCheck(promise);
    expect(service.getPendingCheck()).toBe(promise);
    expect(service.shouldAllowCheck()).toBe(false);

    // After resolution, it should clear itself
    return promise.then(() => {
      expect(service.getPendingCheck()).toBeNull();
      expect(service.shouldAllowCheck()).toBe(true);
    });
  });

  it('should calculate exponential backoff with jitter', () => {
    // failureCount = 0: base=100 * 2^0 = 100. Jitter ±25% -> [75, 125]
    const b0 = service.calculateNextBackoffMs();
    expect(b0).toBeGreaterThanOrEqual(75);
    expect(b0).toBeLessThanOrEqual(125);

    service.incrementFailureCount();
    // failureCount = 1: 100 * 2^1 = 200. Jitter ±25% -> [150, 250]
    const b1 = service.calculateNextBackoffMs();
    expect(b1).toBeGreaterThanOrEqual(150);
    expect(b1).toBeLessThanOrEqual(250);

    for (let i = 0; i < 10; i++) service.incrementFailureCount();
    // failureCount = 11: 100 * 2^11 = 204800, capped at 1000. Jitter ±25% -> [750, 1250]
    const b11 = service.calculateNextBackoffMs();
    expect(b11).toBeGreaterThanOrEqual(750);
    expect(b11).toBeLessThanOrEqual(1250);
  });

  it('should record failures and successes correctly', () => {
    service.recordFailure();
    expect(service.getFailureCount()).toBe(1);
    expect(service.isBackoffActive()).toBe(true);
    expect(service.shouldAllowCheck()).toBe(false);

    service.recordSuccess();
    expect(service.getFailureCount()).toBe(0);
    expect(service.getBackoffUntil()).toBe(0);
    expect(service.isBackoffActive()).toBe(false);
    expect(service.shouldAllowCheck()).toBe(true);
  });

  it('waitForBackoff should wait if backoff is active', async () => {
    vi.useFakeTimers();
    
    const backoffUntil = Date.now() + 500;
    service.setBackoffUntil(backoffUntil);
    
    const waitPromise = service.waitForBackoff();
    
    // Should still be pending
    expect(service.getBackoffRemainingMs()).toBeGreaterThan(0);
    
    vi.advanceTimersByTime(600);
    
    await waitPromise;
    expect(service.isBackoffActive()).toBe(false);
  });

  it('should clear state on clear()', () => {
    service.incrementFailureCount();
    service.setBackoffUntil(Date.now() + 1000);
    service.setPendingCheck(Promise.resolve({} as any));
    
    service.clear();
    
    expect(service.getFailureCount()).toBe(0);
    expect(service.getBackoffUntil()).toBe(0);
    expect(service.getPendingCheck()).toBeNull();
  });
});
