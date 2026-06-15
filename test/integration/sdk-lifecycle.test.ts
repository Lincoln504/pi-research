/**
 * SDK Lifecycle Integration Tests
 *
 * Tests the programmatic SDK surface against real service infrastructure
 * (but with mocked LLM and browser calls so these remain deterministic and fast).
 * Covers init → run → dispose → re-init cycle and string-model resolution.
 */

// Set mock env vars before any module-level code in imported modules sees them.
process.env['PI_RESEARCH_MOCK_SEARCH'] = 'true';
process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import type { Model } from '@earendil-works/pi-ai';

const STUB_MODEL: Model<any> = {
  id: 'test-model',
  provider: 'test-provider',
  name: 'Test Model (stub)',
  api: 'anthropic-messages',
  baseUrl: 'https://stub.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

// ─── LLM + agent mocks ──────────────────────────────────────────────────────

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal() as any;
  const synthResponse = {
    content: [{ type: 'text', text: 'Mock synthesis result.\n\nCITED LINKS\n\n1. https://example.com/sdk-test' }],
    usage: { totalTokens: 50, cost: { total: 0.001 } },
    stopReason: 'stop',
  };
  const planResponse = {
    content: [{
      type: 'text',
      text: '```json\n{"action":"synthesize","content":"Mock deep research result for sdk-lifecycle test.\\n\\nCITED LINKS\\n\\n1. https://example.com/sdk-lifecycle","researchers":[],"allQueries":[]}\n```',
    }],
    usage: { totalTokens: 50, cost: { total: 0.001 } },
    stopReason: 'stop',
  };

  // Smart mock: return plan JSON for coordinator/evaluator calls, synthesis text otherwise.
  // Detects coordinator calls by looking for 'coordinator' in the systemPrompt.
  function pickResponse(args: any[]) {
    const callContext = args[1] as { systemPrompt?: string } | undefined;
    const systemPrompt = callContext?.systemPrompt ?? '';
    if (systemPrompt.includes('coordinator') || systemPrompt.includes('evaluator') || systemPrompt.includes('research-knowledge')) {
      return planResponse;
    }
    return synthResponse;
  }

  return {
    ...actual,
    completeSimple: vi.fn().mockImplementation((...args: any[]) => Promise.resolve(pickResponse(args))),
    complete: vi.fn().mockResolvedValue(planResponse),
  };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
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
  shutdownResearchSDK,
} from '../../src/sdk.ts';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SDK Lifecycle Integration', () => {
  afterEach(async () => {
    await shutdownResearchSDK().catch(() => {});
  });

  afterAll(async () => {
    await shutdownResearchSDK().catch(() => {});
  });

  it('runDeepResearch throws "not initialized" before init', async () => {
    await expect(runDeepResearch('test')).rejects.toThrow('SDK not initialized');
  });

  it('initializes with a Model object and produces a research result', async () => {
    await initResearchSDK({ model: STUB_MODEL });
    const result = await runQuickResearch('What is TypeScript?');
    expect(typeof result).toBe('string');
    expect(result).toContain('Mock');
  });

  it('runQuickResearch executes the single-agent pipeline and returns the researcher output', async () => {
    await initResearchSDK({ model: STUB_MODEL });
    const result = await runQuickResearch('What is TypeScript?');
    expect(result).toContain('Mock researcher result');
  });

  it('runDeepResearch executes the coordinator→synthesis pipeline and returns the plan content', async () => {
    await initResearchSDK({ model: STUB_MODEL });
    const result = await runDeepResearch('What is TypeScript?', { depth: 1 });
    expect(result).toContain('Mock synthesis result');
    expect(result).toContain('CITED LINKS');
  });

  it('re-initialize after dispose succeeds without "already registered" error', async () => {
    await initResearchSDK({ model: STUB_MODEL });
    await shutdownResearchSDK();
    await expect(initResearchSDK({ model: STUB_MODEL })).resolves.toBeUndefined();
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
});
