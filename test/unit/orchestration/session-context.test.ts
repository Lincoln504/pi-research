/**
 * Session Context Unit Tests
 * 
 * Verifies the fork vs compact logic in formatParentContext.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatParentContext } from '../../../src/orchestration/session-context';

// Mock logger
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock SDK
vi.mock('@mariozechner/pi-coding-agent', () => ({
  buildSessionContext: vi.fn(() => ({ messages: [] })),
  estimateTokens: vi.fn(),
  serializeConversation: vi.fn(),
  convertToLlm: vi.fn(),
}));

// Mock ai
vi.mock('@mariozechner/pi-ai', () => ({
  complete: vi.fn(),
}));

describe('session-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockCtx = () => ({
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
    model: { id: 'test-model' },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
    },
    getSignal: vi.fn(() => new AbortController().signal),
  } as any);

  it('should return empty message if no messages exist', async () => {
    const { buildSessionContext } = await import('@mariozechner/pi-coding-agent');
    vi.mocked(buildSessionContext).mockReturnValue({ messages: [] } as any);
    
    const result = await formatParentContext(createMockCtx());
    expect(result).toBe('No previous context available.');
  });

  it('should use Fork mode (direct history) when tokens are below threshold', async () => {
    const { buildSessionContext, estimateTokens, serializeConversation } = await import('@mariozechner/pi-coding-agent');
    
    vi.mocked(buildSessionContext).mockReturnValue({ messages: [{ role: 'user', content: 'hello' }] } as any);
    vi.mocked(estimateTokens).mockReturnValue(500); // Below 2000
    vi.mocked(serializeConversation).mockReturnValue('User: hello');

    const result = await formatParentContext(createMockCtx());
    
    expect(result).toContain('Recent Conversation History');
    expect(result).toContain('User: hello');
    
    const { complete } = await import('@mariozechner/pi-ai');
    expect(complete).not.toHaveBeenCalled();
  });

  it('should use Compact mode (summary) when tokens exceed threshold', async () => {
    const { buildSessionContext, estimateTokens, serializeConversation } = await import('@mariozechner/pi-coding-agent');
    const { complete } = await import('@mariozechner/pi-ai');

    vi.mocked(buildSessionContext).mockReturnValue({ messages: new Array(20).fill({ role: 'user', content: 'test' }) } as any);
    vi.mocked(estimateTokens).mockReturnValue(5000); // Above 2000
    vi.mocked(serializeConversation).mockReturnValue('Long history...');
    vi.mocked(complete).mockResolvedValue({
      content: [{ type: 'text', text: 'This is a compact summary.' }],
    } as any);

    const result = await formatParentContext(createMockCtx());
    
    expect(result).toContain('Compacted Context Summary');
    expect(result).toContain('This is a compact summary.');
    expect(complete).toHaveBeenCalled();
  });

  it('should fallback to direct history if summary generation fails', async () => {
    const { buildSessionContext, estimateTokens, serializeConversation } = await import('@mariozechner/pi-coding-agent');
    const { complete } = await import('@mariozechner/pi-ai');

    vi.mocked(buildSessionContext).mockReturnValue({ messages: [{ role: 'user', content: 'test' }] } as any);
    vi.mocked(estimateTokens).mockReturnValue(5000); // Above 2000
    vi.mocked(complete).mockRejectedValue(new Error('AI failed'));
    vi.mocked(serializeConversation).mockReturnValue('User: test');

    const result = await formatParentContext(createMockCtx());
    
    expect(result).toContain('Recent Context (Summary Failed)');
    expect(result).toContain('User: test');
  });
});
