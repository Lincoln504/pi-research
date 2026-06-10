import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EchoGuard } from '../../../src/utils/input-guard.ts';

describe('EchoGuard', () => {
  let guard: EchoGuard;

  beforeEach(() => {
    guard = new EchoGuard();
  });

  it('should track and detect exact matches', () => {
    const largeResult = 'A'.repeat(500);
    guard.trackResult(largeResult);
    expect(guard.isEcho(largeResult)).toBe(true);
  });

  it('should detect prefix matches (truncated echo)', () => {
    const largeResult = 'Prefix content that is quite long and unique ' + 'B'.repeat(500);
    guard.trackResult(largeResult);
    
    // Truncated version of the EXACT same content
    const echo = largeResult.substring(0, 200);
    expect(guard.isEcho(echo)).toBe(true);
  });

  it('should detect large subset matches', () => {
    const largeResult = 'Prefix ' + 'Center content that is long' + ' Suffix';
    const resultWithPadding = 'A'.repeat(100) + largeResult + 'B'.repeat(100);
    guard.trackResult(resultWithPadding);
    
    // If the input is long enough (>500) and contained in a result
    const longSubset = 'Center content that is long'.repeat(20); 
    const resultWithLongSubset = 'Start ' + longSubset + ' End';
    guard.trackResult(resultWithLongSubset);
    
    expect(guard.isEcho(longSubset)).toBe(true);
  });

  it('should ignore short inputs (legitimate steering)', () => {
    guard.trackResult('A'.repeat(500));
    expect(guard.isEcho('Look for more details')).toBe(false);
  });

  it('should block commands', () => {
    expect(guard.isEcho('/research something')).toBe(true);
  });

  it('should normalize whitespace and ANSI codes', () => {
    const ansiResult = '\x1b[32mGreen Text\x1b[0m ' + 'D'.repeat(500);
    guard.trackResult(ansiResult);
    
    const plainEcho = 'Green Text ' + 'D'.repeat(500);
    expect(guard.isEcho(plainEcho)).toBe(true);
  });

  it('should enforce cache size', () => {
    // Fill cache
    for (let i = 0; i < 15; i++) {
      guard.trackResult('Result ' + i + ' ' + 'E'.repeat(300));
    }
    
    // Result 0 should be evicted (cache size is 10)
    expect(guard.isEcho('Result 0 ' + 'E'.repeat(300))).toBe(false);
    // Result 14 should still be there
    expect(guard.isEcho('Result 14 ' + 'E'.repeat(300))).toBe(true);
  });
});
