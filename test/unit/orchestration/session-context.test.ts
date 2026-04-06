/**
 * Session Context Unit Tests
 * 
 * Verifies the formatting of parent context for the initial coordinator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatParentContext } from '../../../src/orchestration/session-context';

// Mock SDK
vi.mock('@mariozechner/pi-coding-agent', () => ({
  buildSessionContext: vi.fn(() => ({ messages: [] })),
  serializeConversation: vi.fn(),
  convertToLlm: vi.fn((m) => m),
}));

describe('session-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockCtx = () => ({
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
  } as any);

  it('should return empty message if no messages exist', async () => {
    const { buildSessionContext } = await import('@mariozechner/pi-coding-agent');
    vi.mocked(buildSessionContext).mockReturnValue({ messages: [] } as any);
    
    const result = await formatParentContext(createMockCtx());
    expect(result).toBe('No previous context available.');
  });

  it('should return serialized conversation history', async () => {
    const { buildSessionContext, serializeConversation } = await import('@mariozechner/pi-coding-agent');
    
    const mockMessages = [{ role: 'user', content: 'hello' }];
    vi.mocked(buildSessionContext).mockReturnValue({ messages: mockMessages } as any);
    vi.mocked(serializeConversation).mockReturnValue('User: hello');

    const result = await formatParentContext(createMockCtx());
    
    expect(result).toContain('## Parent Conversation History');
    expect(result).toContain('User: hello');
    expect(serializeConversation).toHaveBeenCalled();
  });
});
