/**
 * SDK Lifecycle Integration Tests
 *
 * Tests the programmatic SDK surface against real service infrastructure
 * (but with mocked LLM and browser calls so these remain deterministic and fast).
 * Covers init → run → dispose → re-init cycle and string-model resolution.
 *
 * CI note: lifecycle tests use a stub Model object directly to avoid a dependency
 * on the user-local ~/.pi/agent/models.json. String-model resolution error-path
 * tests (model not found, invalid format) work in CI too since they test our
 * own validation logic, not a successful lookup.
 */

// Set mock env vars before any module-level code in imported modules sees them.
// Without these, runHealthCheck() marks BrowserCapability as critical-unhealthy
// and research throws "Research cannot start: Camoufox not found."
// The browser pool is not needed here — createAgentSession is fully mocked.
process.env['PI_RESEARCH_MOCK_SEARCH'] = 'true';
process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
// Disable the knowledge store so LanceDB/GPU embeddings are not initialised.
process.env['PI_RESEARCH_LOCAL_KNOWLEDGE_ENABLED'] = 'false';
process.env['PI_RESEARCH_GLOBAL_KNOWLEDGE_ENABLED'] = 'false';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
  // completeSimple is used for synthesis — return valid markdown with citations.
  const synthResponse = {
    content: [{ type: 'text', text: 'Mock synthesis result.\n\n### CITED LINKS\n\n1. https://example.com/sdk-test' }],
    usage: { totalTokens: 50, cost: { total: 0.001 } },
    stopReason: 'stop',
  };
  // complete() is used by the planning coordinator. Return a valid JSON plan with
  // action=synthesize so the deep research orchestrator skips the search phase
  // and returns immediately without starting the browser worker pool.
  const planResponse = {
    content: [{
      type: 'text',
      text: '```json\n{"action":"synthesize","content":"Mock deep research result for sdk-lifecycle test.\\n\\n### CITED LINKS\\n\\n1. https://example.com/sdk-lifecycle","researchers":[],"allQueries":[]}\n```',
    }],
    usage: { totalTokens: 50, cost: { total: 0.001 } },
    stopReason: 'stop',
  };
  return {
    ...actual,
    completeSimple: vi.fn().mockResolvedValue(synthResponse),
    complete: vi.fn().mockResolvedValue(planResponse),
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

  it('initializes with a Model object and produces a research result', async () => {
    await initResearchSDK({ model: STUB_MODEL });
    // Verify the SDK is functional post-init by running a quick research and
    // checking the result comes from the mocked synthesis pipeline.
    const result = await runQuickResearch('What is TypeScript?');
    expect(typeof result).toBe('string');
    expect(result).toContain('Mock');
    await disposeResearchSDK();
  });

  it('runQuickResearch executes the single-agent pipeline and returns the researcher output', async () => {
    await initResearchSDK({ model: STUB_MODEL });
    const result = await runQuickResearch('What is TypeScript?');
    // Quick research: health check → createResearcherSession (mocked via
    // createAgentSession) → session.prompt() → reads session.messages directly.
    // No separate synthesis LLM call; result is the researcher's own text.
    expect(result).toContain('Mock researcher result');
    await disposeResearchSDK();
  });

  it('runDeepResearch executes the coordinator→synthesis pipeline and returns the plan content', async () => {
    await initResearchSDK({ model: STUB_MODEL });
    const result = await runDeepResearch('What is TypeScript?', { depth: 1 });
    // Deep research: planning (complete mock returns synthesize plan) → loop breaks
    // → loopSynthesisPlan.content used directly, no extra synthesis LLM call.
    expect(result).toContain('Mock deep research result');
    expect(result).toContain('CITED LINKS');
    await disposeResearchSDK();
  });

  it('re-initialize after dispose succeeds without "already registered" error', async () => {
    await initResearchSDK({ model: STUB_MODEL });
    await disposeResearchSDK();
    // Second init must succeed — this was broken before the resetServiceContainer fix
    await expect(
      initResearchSDK({ model: STUB_MODEL })
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
