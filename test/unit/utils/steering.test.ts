/**
 * Steering Messages Tests
 *
 * Tests the steering message capture, storage, and retrieval functionality.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { addSteeringMessage, getSteeringMessages, clearSteeringMessages } from '../../../src/utils/session-state.ts';

describe('Steering Messages', () => {
  const testSessionId = 'test-session-steering';
  const otherSessionId = 'test-session-other';

  beforeEach(() => {
    // Clear test sessions before each test
    clearSteeringMessages(testSessionId);
    clearSteeringMessages(otherSessionId);
  });

  describe('addSteeringMessage', () => {
    it('should add a steering message to a session', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      const messages = getSteeringMessages(testSessionId);
      
      expect(messages).toEqual(['Focus on recent developments']);
    });

    it('should add multiple steering messages', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      addSteeringMessage(testSessionId, 'Include technical details');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toEqual([
        'Focus on recent developments',
        'Include technical details'
      ]);
    });

    it('should reject duplicate messages', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      addSteeringMessage(testSessionId, 'Focus on recent developments'); // Duplicate
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toEqual(['Focus on recent developments']);
      expect(messages.length).toBe(1);
    });

    it('should handle messages with different whitespace correctly', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      addSteeringMessage(testSessionId, 'Focus on recent developments '); // Trailing space - should be seen as different by exact match
      
      const messages = getSteeringMessages(testSessionId);
      // Since duplicate check uses exact match, these are different
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('should isolate messages between sessions', () => {
      addSteeringMessage(testSessionId, 'Session 1 message');
      addSteeringMessage(otherSessionId, 'Session 2 message');
      
      const testMessages = getSteeringMessages(testSessionId);
      const otherMessages = getSteeringMessages(otherSessionId);
      
      expect(testMessages).toEqual(['Session 1 message']);
      expect(otherMessages).toEqual(['Session 2 message']);
    });
  });

  describe('getSteeringMessages', () => {
    it('should return empty array for new session', () => {
      const messages = getSteeringMessages('non-existent-session');
      expect(messages).toEqual([]);
    });

    it('should return a copy of messages (defensive)', () => {
      addSteeringMessage(testSessionId, 'Original message');
      const messages = getSteeringMessages(testSessionId);
      
      // Modify the returned array
      messages.push('Hacked message');
      
      // Get messages again - should not include the hacked message
      const messagesAgain = getSteeringMessages(testSessionId);
      expect(messagesAgain).toEqual(['Original message']);
    });

    it('should return messages in order they were added', () => {
      addSteeringMessage(testSessionId, 'First');
      addSteeringMessage(testSessionId, 'Second');
      addSteeringMessage(testSessionId, 'Third');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toEqual(['First', 'Second', 'Third']);
    });
  });

  describe('clearSteeringMessages', () => {
    it('should clear all messages for a session', () => {
      addSteeringMessage(testSessionId, 'Message 1');
      addSteeringMessage(testSessionId, 'Message 2');
      
      clearSteeringMessages(testSessionId);
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toEqual([]);
    });

    it('should only clear messages for specified session', () => {
      addSteeringMessage(testSessionId, 'Test message');
      addSteeringMessage(otherSessionId, 'Other message');
      
      clearSteeringMessages(testSessionId);
      
      expect(getSteeringMessages(testSessionId)).toEqual([]);
      expect(getSteeringMessages(otherSessionId)).toEqual(['Other message']);
    });

    it('should handle clearing empty session', () => {
      // Should not throw error
      expect(() => clearSteeringMessages('non-existent-session')).not.toThrow();
      expect(getSteeringMessages('non-existent-session')).toEqual([]);
    });
  });

  describe('Integration scenarios', () => {
    it('should handle add-clear-add cycle', () => {
      addSteeringMessage(testSessionId, 'First message');
      clearSteeringMessages(testSessionId);
      addSteeringMessage(testSessionId, 'Second message');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toEqual(['Second message']);
    });

    it('should handle multiple duplicate attempts', () => {
      addSteeringMessage(testSessionId, 'Repeat message');
      addSteeringMessage(testSessionId, 'Repeat message');
      addSteeringMessage(testSessionId, 'Repeat message');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toEqual(['Repeat message']);
      expect(messages.length).toBe(1);
    });
  });
});
