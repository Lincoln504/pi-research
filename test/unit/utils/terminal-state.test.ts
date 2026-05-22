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
    it('should consume kitty responses', () => {
      expect(shouldConsumeForCleanup('\x1b[?4;1;3u')).toBe(true);
    });

    it('should consume CSI sequences', () => {
      expect(shouldConsumeForCleanup('\x1b[0m')).toBe(true);
      expect(shouldConsumeForCleanup('\x1b[1A')).toBe(true);
      expect(shouldConsumeForCleanup('\x1b[?25h')).toBe(true);
    });

    it('should consume ESC character itself', () => {
      expect(shouldConsumeForCleanup('\x1b')).toBe(true);
    });

    it('should not consume normal text', () => {
      expect(shouldConsumeForCleanup('hello')).toBe(false);
      expect(shouldConsumeForCleanup(' ')).toBe(false);
      expect(shouldConsumeForCleanup('123')).toBe(false);
    });
  });
});
