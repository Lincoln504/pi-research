import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isKittyProtocolResponse, shouldConsumeForCleanup } from '../../../src/utils/terminal-state.ts';

describe('terminal-state', () => {
  describe('isKittyProtocolResponse', () => {
    it('should match standard kitty responses', () => {
      expect(isKittyProtocolResponse('\x1b[?4;1;3u')).toBe(true);
      expect(isKittyProtocolResponse('\x1b[?0u')).toBe(true);
      expect(isKittyProtocolResponse('\x1b[?1u')).toBe(true);
    });

    it('should match multi-parameter responses', () => {
      expect(isKittyProtocolResponse('\x1b[?1;2;3;4;5;6;7u')).toBe(true);
    });

    it('should not match other CSI sequences', () => {
      expect(isKittyProtocolResponse('\x1b[0m')).toBe(false);
      expect(isKittyProtocolResponse('\x1b[1A')).toBe(false);
      expect(isKittyProtocolResponse('\x1b[?25h')).toBe(false);
    });
  });

  describe('shouldConsumeForCleanup', () => {
    it('should consume kitty status responses', () => {
      expect(shouldConsumeForCleanup('\x1b[?4;1;3u')).toBe(true);
      expect(shouldConsumeForCleanup('\x1b[?0u')).toBe(true);
    });

    it('should NOT consume interaction keys (Arrows, Kitty keys)', () => {
      expect(shouldConsumeForCleanup('\x1b[A')).toBe(false); // Up
      expect(shouldConsumeForCleanup('\x1b[B')).toBe(false); // Down
      expect(shouldConsumeForCleanup('\x1b[13u')).toBe(false); // Kitty Enter
    });

    it('should consume terminal status responses (CPR)', () => {
      expect(shouldConsumeForCleanup('\x1b[24;80R')).toBe(true); // Cursor Position Report
    });

    it('should NOT consume ESC character itself (handled by tool, not cleanup)', () => {
      expect(shouldConsumeForCleanup('\x1b')).toBe(false);
    });

    it('should not consume normal text', () => {
      expect(shouldConsumeForCleanup('hello')).toBe(false);
      expect(shouldConsumeForCleanup(' ')).toBe(false);
      expect(shouldConsumeForCleanup('123')).toBe(false);
    });
  });
});
