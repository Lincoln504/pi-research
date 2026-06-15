import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorTracker, errorTracker, runWithTracker } from '../../../src/utils/error-tracker';

describe('ErrorTracker', () => {
  let tracker: ErrorTracker;

  beforeEach(() => {
    tracker = new ErrorTracker();
  });

  it('should accurately count errors by type', () => {
    tracker.trackError('Fetch blocked: Cloudflare challenge');
    tracker.trackError('Fetch blocked: Cloudflare challenge');
    tracker.trackError('HTTP 403');

    const report = tracker.getReport();
    expect(report.totalErrors).toBe(3);
    expect(report.byType.get('Fetch blocked')).toBe(2);
    expect(report.byType.get('HTTP 403')).toBe(1);
  });

  it('counts per-domain errors without exceeding the total', () => {
    const errorMessage = 'Fetch blocked: Cloudflare challenge';

    // Five errors for the same domain and error signature.
    for (let i = 0; i < 5; i++) {
      tracker.trackError(errorMessage, { domain: 'example.com' });
    }

    const report = tracker.getReport();
    expect(report.totalErrors).toBe(5);
    // The per-domain tally must equal the total, not the capped context list.
    expect(report.byDomain.get('example.com')).toBe(5);
  });

  it('should handle multiple domains for the same error pattern', () => {
    const errorMessage = 'Connection timeout';
    
    tracker.trackError(errorMessage, { domain: 'a.com' });
    tracker.trackError(errorMessage, { domain: 'a.com' });
    tracker.trackError(errorMessage, { domain: 'b.com' });

    const report = tracker.getReport();
    expect(report.totalErrors).toBe(3);
    
    expect(report.byDomain.get('a.com')).toBe(2);
    expect(report.byDomain.get('b.com')).toBe(1);
  });

  it('should isolate errors between concurrent runs using runWithTracker', () => {
    const sessionTracker1 = new ErrorTracker();
    const sessionTracker2 = new ErrorTracker();

    runWithTracker(sessionTracker1, () => {
      errorTracker.trackError('Error in session 1');
    });

    runWithTracker(sessionTracker2, () => {
      errorTracker.trackError('Error in session 2');
      errorTracker.trackError('Another error in session 2');
    });

    // Global tracker should be empty
    expect(errorTracker.getReport().totalErrors).toBe(0);

    // Session trackers should have their own errors
    expect(sessionTracker1.getReport().totalErrors).toBe(1);
    expect(sessionTracker2.getReport().totalErrors).toBe(2);
  });
});
