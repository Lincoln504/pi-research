/**
 * Steering Messages Tests
 *
 * Tests the steering message capture, storage, state transitions,
 * and retrieval functionality including the queued/active/popped lifecycle.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addSteeringMessage,
  getSteeringMessages,
  clearSteeringMessages,
  getQueuedSteeringMessages,
  getActiveSteeringMessages,
  consumeQueuedMessages,
  popQueuedMessages,
  requeuePoppedMessage,
  hasQueuedSteeringMessages,
  normalizeSessionId,
} from '../../../src/orchestration/session-state.ts';
import { resetAllPiSessions } from '../../../src/orchestration/session-state.ts';

describe('Steering Messages', () => {
  const testSessionId = 'test-session-steering';
  const otherSessionId = 'test-session-other';

  beforeEach(() => {
    // Reset all sessions completely before each test
    resetAllPiSessions();
  });

  // ─── addSteeringMessage ──────────────────────────────────────────────────────

  describe('addSteeringMessage', () => {
    it('should add a steering message to a session as queued', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      const messages = getSteeringMessages(testSessionId);
      
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toBe('Focus on recent developments');
      expect(messages[0]!.status).toBe('queued');
      expect(messages[0]!.id).toBeDefined();
      expect(messages[0]!.addedAt).toBeGreaterThan(0);
      expect(messages[0]!.consumedAt).toBeNull();
      expect(messages[0]!.poppedAt).toBeNull();
    });

    it('should add multiple steering messages', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      addSteeringMessage(testSessionId, 'Include technical details');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.text).toBe('Focus on recent developments');
      expect(messages[1]!.text).toBe('Include technical details');
    });

    it('should reject duplicate messages', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toHaveLength(1);
    });

    it('should reject duplicates that differ only in whitespace', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      addSteeringMessage(testSessionId, 'Focus on recent  developments');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toHaveLength(1);
    });

    it('should allow the same text if the first one was popped', () => {
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      popQueuedMessages(testSessionId);
      
      addSteeringMessage(testSessionId, 'Focus on recent developments');
      const messages = getSteeringMessages(testSessionId);
      // The popped message is filtered from getSteeringMessages, so we see the new one
      expect(messages).toHaveLength(1);
      expect(messages[0]!.status).toBe('queued');
    });

    it('should isolate messages between sessions', () => {
      addSteeringMessage(testSessionId, 'Session 1 message');
      addSteeringMessage(otherSessionId, 'Session 2 message');
      
      const testMessages = getSteeringMessages(testSessionId);
      const otherMessages = getSteeringMessages(otherSessionId);
      
      expect(testMessages).toHaveLength(1);
      expect(testMessages[0]!.text).toBe('Session 1 message');
      expect(otherMessages).toHaveLength(1);
      expect(otherMessages[0]!.text).toBe('Session 2 message');
    });

    it('should assign unique IDs to each message', () => {
      addSteeringMessage(testSessionId, 'Message 1');
      addSteeringMessage(testSessionId, 'Message 2');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages[0]!.id).not.toBe(messages[1]!.id);
    });
  });

  // ─── getSteeringMessages ──────────────────────────────────────────────────────

  describe('getSteeringMessages', () => {
    it('should return empty array for new session', () => {
      const messages = getSteeringMessages('non-existent-session');
      expect(messages).toEqual([]);
    });

    it('should return a copy of messages (defensive)', () => {
      addSteeringMessage(testSessionId, 'Original message');
      const messages = getSteeringMessages(testSessionId);
      
      // Modify the returned array
      messages.push({ id: 'fake', text: 'Hacked', status: 'queued', addedAt: 0, consumedAt: null, poppedAt: null });
      
      // Get messages again - should not include the hacked message
      const messagesAgain = getSteeringMessages(testSessionId);
      expect(messagesAgain).toHaveLength(1);
    });

    it('should return messages in order they were added', () => {
      addSteeringMessage(testSessionId, 'First');
      addSteeringMessage(testSessionId, 'Second');
      addSteeringMessage(testSessionId, 'Third');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages.map(m => m.text)).toEqual(['First', 'Second', 'Third']);
    });

    it('should exclude popped messages', () => {
      addSteeringMessage(testSessionId, 'Keep this');
      addSteeringMessage(testSessionId, 'Pop this');
      popQueuedMessages(testSessionId);
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toHaveLength(0);
    });
  });

  // ─── getQueuedSteeringMessages ────────────────────────────────────────────────

  describe('getQueuedSteeringMessages', () => {
    it('should return only queued messages', () => {
      addSteeringMessage(testSessionId, 'Queued');
      addSteeringMessage(testSessionId, 'Also queued');
      
      const queued = getQueuedSteeringMessages(testSessionId);
      expect(queued).toHaveLength(2);
      expect(queued.every(m => m.status === 'queued')).toBe(true);
    });

    it('should not return active messages', () => {
      addSteeringMessage(testSessionId, 'Will be active');
      consumeQueuedMessages(testSessionId);
      
      const queued = getQueuedSteeringMessages(testSessionId);
      expect(queued).toHaveLength(0);
    });

    it('should not return popped messages', () => {
      addSteeringMessage(testSessionId, 'Will be popped');
      popQueuedMessages(testSessionId);
      
      const queued = getQueuedSteeringMessages(testSessionId);
      expect(queued).toHaveLength(0);
    });
  });

  // ─── getActiveSteeringMessages ────────────────────────────────────────────────

  describe('getActiveSteeringMessages', () => {
    it('should return only active messages', () => {
      addSteeringMessage(testSessionId, 'Will be active');
      consumeQueuedMessages(testSessionId);
      
      const active = getActiveSteeringMessages(testSessionId);
      expect(active).toHaveLength(1);
      expect(active[0]!.status).toBe('active');
    });

    it('should not return queued messages', () => {
      addSteeringMessage(testSessionId, 'Still queued');
      
      const active = getActiveSteeringMessages(testSessionId);
      expect(active).toHaveLength(0);
    });
  });

  // ─── consumeQueuedMessages ──────────────────────────────────────────────────

  describe('consumeQueuedMessages', () => {
    it('should transition queued messages to active', () => {
      addSteeringMessage(testSessionId, 'Message 1');
      addSteeringMessage(testSessionId, 'Message 2');
      
      const consumed = consumeQueuedMessages(testSessionId);
      expect(consumed).toHaveLength(2);
      expect(consumed.every(m => m.status === 'active')).toBe(true);
      expect(consumed.every(m => m.consumedAt !== null)).toBe(true);
    });

    it('should return empty array when no queued messages', () => {
      const consumed = consumeQueuedMessages(testSessionId);
      expect(consumed).toHaveLength(0);
    });

    it('should not re-consume already active messages', () => {
      addSteeringMessage(testSessionId, 'Active message');
      consumeQueuedMessages(testSessionId);
      
      // Consume again — should return nothing new
      const consumedAgain = consumeQueuedMessages(testSessionId);
      expect(consumedAgain).toHaveLength(0);
    });

    it('should consume newly queued messages on second call', () => {
      addSteeringMessage(testSessionId, 'First batch');
      consumeQueuedMessages(testSessionId);
      
      addSteeringMessage(testSessionId, 'Second batch');
      const consumed = consumeQueuedMessages(testSessionId);
      expect(consumed).toHaveLength(1);
      expect(consumed[0]!.text).toBe('Second batch');
    });

    it('should be atomic — all messages transition together', () => {
      addSteeringMessage(testSessionId, 'A');
      addSteeringMessage(testSessionId, 'B');
      addSteeringMessage(testSessionId, 'C');
      
      const consumed = consumeQueuedMessages(testSessionId);
      expect(consumed).toHaveLength(3);
      
      const queued = getQueuedSteeringMessages(testSessionId);
      expect(queued).toHaveLength(0);
      
      const active = getActiveSteeringMessages(testSessionId);
      expect(active).toHaveLength(3);
    });
  });

  // ─── popQueuedMessages ──────────────────────────────────────────────────────

  describe('popQueuedMessages', () => {
    it('should transition queued messages to popped', () => {
      addSteeringMessage(testSessionId, 'Will be popped');
      
      const popped = popQueuedMessages(testSessionId);
      expect(popped).toHaveLength(1);
      expect(popped[0]!.status).toBe('popped');
      expect(popped[0]!.poppedAt).not.toBeNull();
    });

    it('should return empty when no queued messages', () => {
      const popped = popQueuedMessages(testSessionId);
      expect(popped).toHaveLength(0);
    });

    it('should NOT pop active messages', () => {
      addSteeringMessage(testSessionId, 'Active');
      consumeQueuedMessages(testSessionId);
      
      const popped = popQueuedMessages(testSessionId);
      expect(popped).toHaveLength(0);
      
      // Active messages still exist
      const active = getActiveSteeringMessages(testSessionId);
      expect(active).toHaveLength(1);
    });

    it('should only pop queued, leaving active intact', () => {
      addSteeringMessage(testSessionId, 'Active');
      consumeQueuedMessages(testSessionId);
      
      addSteeringMessage(testSessionId, 'Queued');
      
      const popped = popQueuedMessages(testSessionId);
      expect(popped).toHaveLength(1);
      expect(popped[0]!.text).toBe('Queued');
      
      const active = getActiveSteeringMessages(testSessionId);
      expect(active).toHaveLength(1);
      expect(active[0]!.text).toBe('Active');
    });

    it('popped messages should not appear in getSteeringMessages', () => {
      addSteeringMessage(testSessionId, 'Pop me');
      popQueuedMessages(testSessionId);

      const all = getSteeringMessages(testSessionId);
      expect(all).toHaveLength(0);
    });
  });

  // ─── requeuePoppedMessage ───────────────────────────────────────────────────

  describe('requeuePoppedMessage', () => {
    it('restores a popped message to queued so a failed forward is never lost', () => {
      addSteeringMessage(testSessionId, 'now write the cover letters');
      const popped = popQueuedMessages(testSessionId);
      expect(popped).toHaveLength(1);
      // Simulate the pop handler's forward to pi failing.
      requeuePoppedMessage(testSessionId, popped[0]!.id);

      const queued = getQueuedSteeringMessages(testSessionId);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.text).toBe('now write the cover letters');
      expect(queued[0]!.status).toBe('queued');
      // It is poppable again.
      expect(hasQueuedSteeringMessages(testSessionId)).toBe(true);
    });

    it('is a no-op for an unknown id or a non-popped message', () => {
      addSteeringMessage(testSessionId, 'still queued');
      requeuePoppedMessage(testSessionId, 'no-such-id');
      requeuePoppedMessage(testSessionId, getQueuedSteeringMessages(testSessionId)[0]!.id);
      const queued = getQueuedSteeringMessages(testSessionId);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.status).toBe('queued');
    });
  });

  // ─── hasQueuedSteeringMessages ──────────────────────────────────────────────

  describe('hasQueuedSteeringMessages', () => {
    it('should return false when no messages', () => {
      expect(hasQueuedSteeringMessages(testSessionId)).toBe(false);
    });

    it('should return true when queued messages exist', () => {
      addSteeringMessage(testSessionId, 'Queued');
      expect(hasQueuedSteeringMessages(testSessionId)).toBe(true);
    });

    it('should return false when all messages are active', () => {
      addSteeringMessage(testSessionId, 'Active');
      consumeQueuedMessages(testSessionId);
      expect(hasQueuedSteeringMessages(testSessionId)).toBe(false);
    });

    it('should return false when all messages are popped', () => {
      addSteeringMessage(testSessionId, 'Popped');
      popQueuedMessages(testSessionId);
      expect(hasQueuedSteeringMessages(testSessionId)).toBe(false);
    });
  });

  // ─── clearSteeringMessages ──────────────────────────────────────────────────

  describe('clearSteeringMessages', () => {
    it('should clear all messages regardless of state', () => {
      addSteeringMessage(testSessionId, 'Queued');
      addSteeringMessage(testSessionId, 'Will be active');
      consumeQueuedMessages(testSessionId);
      addSteeringMessage(testSessionId, 'Also queued');
      
      clearSteeringMessages(testSessionId);
      
      expect(getSteeringMessages(testSessionId)).toHaveLength(0);
      expect(getActiveSteeringMessages(testSessionId)).toHaveLength(0);
      expect(getQueuedSteeringMessages(testSessionId)).toHaveLength(0);
    });

    it('should only clear messages for specified session', () => {
      addSteeringMessage(testSessionId, 'Test message');
      addSteeringMessage(otherSessionId, 'Other message');
      
      clearSteeringMessages(testSessionId);
      
      expect(getSteeringMessages(testSessionId)).toHaveLength(0);
      expect(getSteeringMessages(otherSessionId)).toHaveLength(1);
    });

    it('should handle clearing empty session', () => {
      expect(() => clearSteeringMessages('non-existent-session')).not.toThrow();
      expect(getSteeringMessages('non-existent-session')).toEqual([]);
    });
  });

  // ─── State Machine Integration ──────────────────────────────────────────────

  describe('State Machine Integration', () => {
    it('should support the full lifecycle: queued → active', () => {
      addSteeringMessage(testSessionId, 'Focus on X');
      
      // Verify queued
      expect(hasQueuedSteeringMessages(testSessionId)).toBe(true);
      expect(getQueuedSteeringMessages(testSessionId)).toHaveLength(1);
      
      // Consume
      const consumed = consumeQueuedMessages(testSessionId);
      expect(consumed).toHaveLength(1);
      
      // Verify active
      expect(hasQueuedSteeringMessages(testSessionId)).toBe(false);
      expect(getActiveSteeringMessages(testSessionId)).toHaveLength(1);
      expect(getSteeringMessages(testSessionId)).toHaveLength(1);
    });

    it('should support the pop lifecycle: queued → popped', () => {
      addSteeringMessage(testSessionId, 'Focus on X');
      
      // Pop
      const popped = popQueuedMessages(testSessionId);
      expect(popped).toHaveLength(1);
      expect(popped[0]!.text).toBe('Focus on X');
      
      // Verify gone from all views
      expect(getSteeringMessages(testSessionId)).toHaveLength(0);
      expect(getQueuedSteeringMessages(testSessionId)).toHaveLength(0);
      expect(getActiveSteeringMessages(testSessionId)).toHaveLength(0);
    });

    it('should handle add-clear-add cycle', () => {
      addSteeringMessage(testSessionId, 'First message');
      clearSteeringMessages(testSessionId);
      addSteeringMessage(testSessionId, 'Second message');
      
      const messages = getSteeringMessages(testSessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toBe('Second message');
    });

    it('should handle interleaved consume and pop', () => {
      addSteeringMessage(testSessionId, 'A');
      addSteeringMessage(testSessionId, 'B');
      consumeQueuedMessages(testSessionId);
      // A and B are now active
      
      addSteeringMessage(testSessionId, 'C');
      addSteeringMessage(testSessionId, 'D');
      // C and D are queued
      
      const popped = popQueuedMessages(testSessionId);
      expect(popped).toHaveLength(2);
      expect(popped.map(m => m.text).sort()).toEqual(['C', 'D']);
      
      const active = getActiveSteeringMessages(testSessionId);
      expect(active).toHaveLength(2);
      expect(active.map(m => m.text).sort()).toEqual(['A', 'B']);
    });
  });

  // ─── Session Isolation ──────────────────────────────────────────────────────

  describe('Session Isolation', () => {
    it('should not leak state between sessions', () => {
      addSteeringMessage(testSessionId, 'Test');
      addSteeringMessage(otherSessionId, 'Other');
      
      consumeQueuedMessages(testSessionId);
      
      // Test session consumed, other still queued
      expect(getActiveSteeringMessages(testSessionId)).toHaveLength(1);
      expect(getQueuedSteeringMessages(otherSessionId)).toHaveLength(1);
      
      // Popping other should not affect test
      popQueuedMessages(otherSessionId);
      expect(getActiveSteeringMessages(testSessionId)).toHaveLength(1);
    });

    it('normalizeSessionId should handle edge cases', () => {
      expect(normalizeSessionId(undefined)).toBe('default');
      expect(normalizeSessionId(null as any)).toBe('default');
      expect(normalizeSessionId('undefined')).toBe('default');
      expect(normalizeSessionId('null')).toBe('default');
      expect(normalizeSessionId('')).toBe('default');
      expect(normalizeSessionId('valid-id')).toBe('valid-id');
    });
  });
});
