/**
 * SDK Lifecycle Integration Tests
 *
 * Tests the programmatic SDK surface against real service infrastructure
 * (but with mocked LLM and browser calls so these remain deterministic and fast).
 * Covers init → run → dispose → re-init cycle and string-model resolution.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// ─── LLM + agent mocks ──────────────────────────────────────────────────────

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal() as any;
  const mockResponse = {
    content: [{ type: 'text', text: 'Mock synthesis result.\n\n### CITED LINKS\n\n1. https://example.com/sdk-test' }],
    usage: { totalTokens: 50, cost: { total: 0.001 } },
    stopReason: 'stop',
  };
  return {
    ...actual,
    completeSimple: vi.fn().mockResolvedValue(mockResponse),
    complete: vi.fn().mockResolvedValue(mockResponse),
  };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    // ModelRegistry, AuthStorage, SettingsManager, SessionManager: keep real implementations
    // so that string model resolution and auth storage reads work correctly.
    createAgentSession: vi.fn().mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue({}),
        subscribe: vi.fn().mockReturnValue(() => {}),
        abort: vi.fn().mockResolvedValue({}),
        messages: [{
          role: 'assistant',
          content: [{ type: 'text', text: 'Mock researcher result for sdk-lifecycle test.' }],
          stopReason: 'stop',
        }],
      },
    }),
  };
});

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  initResearchSDK,
  runDeepResearch,
  runQuickResearch,
  disposeResearchSDK,
} from '../../src/sdk.ts';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SDK Lifecycle Integration', () => {
  afterAll(async () => {
    await disposeResearchSDK().catch(() => {});
  });

  it('initializes with a string model ID from pi config', async () => {
    // glm-coding models are configured in ~/.pi/agent/models.json
    await expect(
      initResearchSDK({ model: 'glm-coding/glm-4.7' })
    ).resolves.toBeUndefined();
    await disposeResearchSDK();
  });

  it('runQuickResearch returns a non-empty string after init', async () => {
    await initResearchSDK({ model: 'glm-coding/glm-4.7' });
    const result = await runQuickResearch('What is TypeScript?');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    await disposeResearchSDK();
  });

  it('runDeepResearch returns a non-empty string at level 1', async () => {
    await initResearchSDK({ model: 'glm-coding/glm-4.7' });
    const result = await runDeepResearch('What is TypeScript?', { depth: 1 });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    await disposeResearchSDK();
  });

  it('re-initialize after dispose succeeds without "already registered" error', async () => {
    await initResearchSDK({ model: 'glm-coding/glm-4.7' });
    await disposeResearchSDK();
    // Second init must succeed — this was broken before the resetServiceContainer fix
    await expect(
      initResearchSDK({ model: 'glm-coding/glm-4.7' })
    ).resolves.toBeUndefined();
    await disposeResearchSDK();
  });

  it('throws when model string is not found in pi config', async () => {
    await expect(
      initResearchSDK({ model: 'nonexistent-provider/nonexistent-model' })
    ).rejects.toThrow('not found in pi\'s configured model registry');
  });

  it('throws when model string format is invalid (no slash)', async () => {
    await expect(
      initResearchSDK({ model: 'no-slash-here' })
    ).rejects.toThrow('Expected "provider/id"');
  });

  it('runDeepResearch throws "not initialized" before init', async () => {
    await expect(runDeepResearch('test')).rejects.toThrow('Research SDK not initialized');
  });
});
