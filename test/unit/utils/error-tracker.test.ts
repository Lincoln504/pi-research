/**
 * Error Tracker Utility Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorTracker } from '../../../src/utils/error-tracker.ts';

describe('Error Tracker Utility', () => {
  beforeEach(() => {
    errorTracker.clear();
  });

  it('tracks simple string errors', () => {
    errorTracker.trackError('Something went wrong');
    const report = errorTracker.getReport();
    
    expect(report.totalErrors).toBe(1);
    expect(report.uniquePatterns).toBe(1);
    expect(report.patterns[0].message).toBe('Something went wrong');
  });

  it('tracks Error objects and extracts messages', () => {
    errorTracker.trackError(new Error('Network failure'));
    const report = errorTracker.getReport();
    
    expect(report.totalErrors).toBe(1);
    expect(report.patterns[0].message).toBe('Network failure');
  });

  it('groups similar errors using patterns', () => {
    // Errors with different IDs but same prefix
    // Use numbers that don't look like HTTP status codes (e.g. > 599 or < 100)
    errorTracker.trackError('Request failed for ID 1001');
    errorTracker.trackError('Request failed for ID 2002');
    errorTracker.trackError('Request failed for ID 3003');
    
    const report = errorTracker.getReport();
    
    expect(report.totalErrors).toBe(3);
    // Signature should be "Request failed for ID <NUM>"
    expect(report.uniquePatterns).toBe(1);
    expect(report.patterns[0].signature).toBe('Request failed for ID <NUM>');
  });

  it('tracks errors with context', () => {
    errorTracker.trackError('Search failed', { toolName: 'search', phase: 'execution' });
    const report = errorTracker.getReport();
    
    expect(report.patterns[0].contexts).toHaveLength(1);
    expect(report.patterns[0].contexts[0].toolName).toBe('search');
  });

  it('clears error history', () => {
    errorTracker.trackError('Oops');
    errorTracker.clear();
    const report = errorTracker.getReport();
    expect(report.totalErrors).toBe(0);
  });
});
