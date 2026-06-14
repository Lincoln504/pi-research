import { describe, it, expect } from 'vitest';
import { 
  splitTerminalSequences,
  isEscapeSequence,
  isInteractionKey
} from '../../../src/tui/utils/terminal-state.ts';

describe('terminal-state', () => {
  describe('splitTerminalSequences', () => {
    it('should split single characters', () => {
      const result = splitTerminalSequences('abc');
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should split single escape sequences', () => {
      const result = splitTerminalSequences('\x1b[A');
      expect(result).toEqual(['\x1b[A']);
    });

    it('should split interleaved sequences and characters', () => {
      const result = splitTerminalSequences('a\x1b[Ab\x1b[Bc');
      expect(result).toEqual(['a', '\x1b[A', 'b', '\x1b[B', 'c']);
    });

    it('should handle OSC sequences', () => {
      const result = splitTerminalSequences('\x1b]0;Title\x07');
      expect(result).toEqual(['\x1b]0;Title\x07']);
      
      const stResult = splitTerminalSequences('\x1b]0;Title\x1b\\');
      expect(stResult).toEqual(['\x1b]0;Title\x1b\\']);
    });

    it('should handle SS3 sequences', () => {
        // ESC O P (F1)
        const result = splitTerminalSequences('\x1bOP');
        expect(result).toEqual(['\x1bOP']);
    });
  });

  describe('isEscapeSequence', () => {
    it('should return true for ESC prefix', () => {
      expect(isEscapeSequence('\x1b[A')).toBe(true);
      expect(isEscapeSequence('\x1b')).toBe(true);
    });

    it('should return false for normal text', () => {
      expect(isEscapeSequence('abc')).toBe(false);
      expect(isEscapeSequence('')).toBe(false);
    });
  });

  describe('isInteractionKey', () => {
    it('should identify arrow keys', () => {
      expect(isInteractionKey('\x1b[A')).toBe(true);
      expect(isInteractionKey('\x1b[B')).toBe(true);
    });

    it('should identify normal text', () => {
      expect(isInteractionKey('a')).toBe(true);
      expect(isInteractionKey('1')).toBe(true);
      expect(isInteractionKey(' ')).toBe(true);
    });

    it('should identify control keys', () => {
      expect(isInteractionKey('\r')).toBe(true);
      expect(isInteractionKey('\n')).toBe(true);
      expect(isInteractionKey('\t')).toBe(true);
      expect(isInteractionKey('\x1b')).toBe(true);
    });
  });
});
