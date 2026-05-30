import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  isKittyProtocolResponse, 
  shouldConsumeForCleanup, 
  splitTerminalSequences,
  createSafeInputHandler
} from '../../../src/utils/terminal-state.ts';

describe('terminal-state', () => {
  describe('splitTerminalSequences', () => {
    it('should split single characters', () => {
      expect(splitTerminalSequences('abc')).toEqual(['a', 'b', 'c']);
    });

    it('should split single escape sequences', () => {
      expect(splitTerminalSequences('\x1b[A')).toEqual(['\x1b[A']);
      expect(splitTerminalSequences('\x1b[24;80R')).toEqual(['\x1b[24;80R']);
    });

    it('should split interleaved sequences and characters', () => {
      expect(splitTerminalSequences('\x1b[?0u\x1b[A')).toEqual(['\x1b[?0u', '\x1b[A']);
      expect(splitTerminalSequences('a\x1b[Ab\x1b[B')).toEqual(['a', '\x1b[A', 'b', '\x1b[B']);
    });

    it('should handle OSC sequences', () => {
      expect(splitTerminalSequences('\x1b]0;title\x07')).toEqual(['\x1b]0;title\x07']);
      expect(splitTerminalSequences('\x1b]0;title\x1b\\')).toEqual(['\x1b]0;title\x1b\\']);
    });
    
    it('should handle SS3 sequences', () => {
        expect(splitTerminalSequences('\x1bOA')).toEqual(['\x1bOA']);
    });
  });

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

    it('should NOT consume batched inputs (defer to safe handler)', () => {
        expect(shouldConsumeForCleanup('\x1b[?0u\x1b[A')).toBe(false);
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

  describe('createSafeInputHandler', () => {
    it('should pass through normal text', () => {
      const base = vi.fn().mockReturnValue(undefined);
      const safe = createSafeInputHandler(base);
      
      const result = safe('a');
      expect(result).toBeUndefined();
      expect(base).toHaveBeenCalledWith('a');
    });

    it('should consume protocol responses', () => {
      const base = vi.fn().mockReturnValue(undefined);
      const safe = createSafeInputHandler(base);
      
      const result = safe('\x1b[?0u');
      expect(result).toEqual({ consume: true });
      expect(base).not.toHaveBeenCalled();
    });

    it('should filter interleaved responses and keys', () => {
      const base = vi.fn().mockReturnValue(undefined);
      const safe = createSafeInputHandler(base);
      
      // Kitty status + Up arrow
      const result = safe('\x1b[?0u\x1b[A');
      expect(result).toEqual({ consume: false, data: '\x1b[A' });
      // The base handler should have been called for the key
      expect(base).toHaveBeenCalledWith('\x1b[A');
    });

    it('should handle purely batched keys', () => {
        const base = vi.fn().mockReturnValue(undefined);
        const safe = createSafeInputHandler(base);
        
        const result = safe('\x1b[A\x1b[B');
        expect(result).toBeUndefined(); // Fall through if nothing consumed
        expect(base).toHaveBeenCalledWith('\x1b[A');
        expect(base).toHaveBeenCalledWith('\x1b[B');
    });
  });
});
