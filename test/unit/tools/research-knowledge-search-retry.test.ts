/**
 * research-knowledge-search — synthesis transient-retry loop (Bug 2 regression)
 *
 * Drives the real runBackgroundExtraction() with a mocked completeSimple to prove the bounded
 * transient-retry actually retries the LLM call (rather than the previous single-shot behaviour
 * that silently mapped a 429 to a knowledge-store MISS and forced a needless live web run).
 *
 * Kept in a separate file from research-knowledge-search.test.ts so the module-level mocks here
 * do not affect that file's hermetic pure-function tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────
const { mockCompleteSimple, mockAbortableDelay } = vi.hoisted(() => ({
  mockCompleteSimple: vi.fn(),
  mockAbortableDelay: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  completeSimple: (...args: unknown[]) => mockCompleteSimple(...args),
}));

// No real backoff wait in tests — assert it is CALLED instead of sleeping.
vi.mock('../../../src/web-research/retry-utils.ts', () => ({
  abortableDelay: (...args: unknown[]) => mockAbortableDelay(...args),
}));

// Deterministic prompt template (avoids touching dist/prompts on disk).
vi.mock('../../../src/core/llm/prompts.ts', () => ({
  loadPrompt: () => 'history: {{conversation_history}}\ndocs: {{reference_documents}}',
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { runBackgroundExtraction } from '../../../src/tools/research-knowledge-search.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODEL = { id: 'test-model', provider: 'test', maxTokens: 4096, contextWindow: 8000 } as any;
const AUTH = { apiKey: 'k', headers: {} };

/** A well-formed assistant response carrying a valid synthesis JSON payload. */
function goodResponse() {
  return {
    stopReason: 'stop',
    content: [{
      type: 'text',
      text: JSON.stringify({
        answer_status: 'yes',
        synthesis: 'The answer is grounded [1].',
        citations: ['https://example.com/a'],
      }),
    }],
    usage: { input: 10, output: 20 },
  };
}

function run(signal?: AbortSignal) {
  return runBackgroundExtraction(MODEL, AUTH, 'what is x?', 'doc body', 5000, 2048, 'off', signal);
}

describe('runBackgroundExtraction — synthesis transient-retry loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAbortableDelay.mockResolvedValue(undefined);
  });

  it('retries after a transient 429 and succeeds on the next attempt', async () => {
    mockCompleteSimple
      .mockRejectedValueOnce(new Error('HTTP 429: rate limit exceeded'))
      .mockResolvedValueOnce(goodResponse());

    const result = await run();

    expect(result.answer_status).toBe('yes');
    expect(mockCompleteSimple).toHaveBeenCalledTimes(2);
    expect(mockAbortableDelay).toHaveBeenCalledTimes(1); // one backoff between the two attempts
  });

  it('exhausts the bounded retries on a persistent transient failure, then throws', async () => {
    mockCompleteSimple.mockRejectedValue(new Error('model is overloaded'));

    await expect(run()).rejects.toThrow(/overloaded/i);
    // KNOWLEDGE_SYNTHESIS_MAX_ATTEMPTS = 3 (1 initial + 2 retries); delay between each.
    expect(mockCompleteSimple).toHaveBeenCalledTimes(3);
    expect(mockAbortableDelay).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-transient error — fails fast on the first attempt', async () => {
    mockCompleteSimple.mockRejectedValue(new Error('invalid API key (401)'));

    await expect(run()).rejects.toThrow(/invalid api key/i);
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(mockAbortableDelay).not.toHaveBeenCalled();
  });

  it('does NOT retry once the abort signal has fired, even for a transient error', async () => {
    const controller = new AbortController();
    controller.abort();
    mockCompleteSimple.mockRejectedValue(new Error('HTTP 429: rate limit exceeded'));

    await expect(run(controller.signal)).rejects.toThrow();
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(mockAbortableDelay).not.toHaveBeenCalled();
  });

  it('succeeds on the first attempt with no retry when the call works', async () => {
    mockCompleteSimple.mockResolvedValueOnce(goodResponse());

    const result = await run();

    expect(result.answer_status).toBe('yes');
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(mockAbortableDelay).not.toHaveBeenCalled();
  });
});
