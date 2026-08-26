import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { repairJsonWithLlm } from '../../../src/core/llm/agentic-repair.ts';
import { getLlmTimeoutMs } from '../../../src/core/llm/llm-timeout.ts';
import { logger } from '../../../src/logger.ts';
import { Type } from 'typebox';
import type { Model } from '@earendil-works/pi-ai';

const stubModel: Model<any> = { id: 'test-model' } as Model<any>;

describe('repairJsonWithLlm', () => {
  const mockCompleter = vi.fn();
  const auth = { apiKey: 'test' };
  const schema = Type.Object({
    foo: Type.String(),
    bar: Type.Number()
  });

  beforeEach(() => {
    mockCompleter.mockReset();
  });

  const baseMessage = {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4o',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now()
  };

  it('salvages valid JSON from a malformed response', async () => {
    mockCompleter.mockResolvedValue({
      ...baseMessage,
      content: [{ type: 'text', text: '```json\n{"foo": "fixed", "bar": 42}\n```' }],
      stopReason: 'stop'
    });

    const result = await repairJsonWithLlm('{"foo": "broken", "bar": "nan"', mockCompleter, auth, {
      model: stubModel,
      schema,
      serviceName: 'TestService'
    });

    expect(result).toEqual({ foo: 'fixed', bar: 42 });
    expect(mockCompleter).toHaveBeenCalledOnce();
    const prompt = mockCompleter.mock.calls[0][1].messages[0]!.content[0]!.text;
    expect(prompt).toContain('JSON Schema');
    expect(prompt).toContain('MALFORMED RESPONSE');
  });

  it('returns null if repair pass still produces invalid JSON', async () => {
    mockCompleter.mockResolvedValue({
      ...baseMessage,
      content: [{ type: 'text', text: 'still not json' }],
      stopReason: 'stop'
    });

    const result = await repairJsonWithLlm('{', mockCompleter, auth, {
      model: stubModel
    });

    expect(result).toBeNull();
  });

  it('returns null if LLM returns empty response', async () => {
    mockCompleter.mockResolvedValue({ 
        ...baseMessage,
        content: [],
        stopReason: 'stop'
    });

    const result = await repairJsonWithLlm('{', mockCompleter, auth, {
      model: stubModel
    });

    expect(result).toBeNull();
  });

  it('coerces values if schema is provided', async () => {
    mockCompleter.mockResolvedValue({
      ...baseMessage,
      content: [{ type: 'text', text: '{"foo": "fixed", "bar": "42"}' }],
      stopReason: 'stop'
    });

    const result = await repairJsonWithLlm('{', mockCompleter, auth, {
      model: stubModel,
      schema
    });

    expect(result).toEqual({ foo: 'fixed', bar: 42 }); // Coerced to number
  });

  it('invokes onUsage with the billed usage on a single-attempt repair', async () => {
    mockCompleter.mockResolvedValue({
      ...baseMessage,
      content: [{ type: 'text', text: '{"foo":"ok","bar":1}' }],
      stopReason: 'stop'
    });
    const onUsage = vi.fn();
    await repairJsonWithLlm('{"foo":', mockCompleter, auth, { model: stubModel, schema, onUsage });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(baseMessage.usage);
  });

  it('invokes onUsage on EVERY billed attempt, including a schema-retry (regression: repair spend was uncounted)', async () => {
    mockCompleter
      .mockResolvedValueOnce({ ...baseMessage, content: [{ type: 'text', text: '{"foo":"x"}' }], stopReason: 'stop' }) // missing bar → schema fail → retry
      .mockResolvedValueOnce({ ...baseMessage, content: [{ type: 'text', text: '{"foo":"x","bar":2}' }], stopReason: 'stop' });
    const onUsage = vi.fn();
    const res = await repairJsonWithLlm('bad', mockCompleter, auth, { model: stubModel, schema, onUsage });
    expect(res).toEqual({ foo: 'x', bar: 2 });
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  describe('abort handling', () => {
    it('stops retrying and returns null quietly when the signal aborts during attempt 1', async () => {
      // Regression: a user cancel mid-salvage was logged at ERROR as "unexpected error"
      // and attempt 2 launched with an already-aborted signal.
      const ac = new AbortController();
      mockCompleter.mockImplementation(() => {
        ac.abort();
        return Promise.reject(new Error('stream torn down'));
      });
      const result = await repairJsonWithLlm('{', mockCompleter, auth, { model: stubModel, signal: ac.signal });
      expect(result).toBeNull();
      expect(mockCompleter).toHaveBeenCalledTimes(1); // attempt 2 never launches
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled(); // clean stop, not an "unexpected error"
      expect(vi.mocked(logger.debug)).toHaveBeenCalled();
    });

    it('never issues an attempt when the signal is already aborted at entry', async () => {
      const ac = new AbortController();
      ac.abort();
      const result = await repairJsonWithLlm('{', mockCompleter, auth, { model: stubModel, signal: ac.signal });
      expect(result).toBeNull();
      expect(mockCompleter).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });

    it('treats an AbortError by name as a cancellation even when no signal was passed', async () => {
      // Mirrors isRetriableLlmError: an abort can surface as an AbortError before the
      // caller's signal state is observable here.
      mockCompleter.mockRejectedValue(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      const result = await repairJsonWithLlm('{', mockCompleter, auth, { model: stubModel });
      expect(result).toBeNull();
      expect(mockCompleter).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });

    it('still retries (and logs at ERROR) on a non-abort unexpected error', async () => {
      mockCompleter.mockRejectedValue(new Error('boom'));
      const result = await repairJsonWithLlm('{', mockCompleter, auth, { model: stubModel });
      expect(result).toBeNull();
      expect(mockCompleter).toHaveBeenCalledTimes(2); // both attempts run
      expect(vi.mocked(logger.error)).toHaveBeenCalled();
    });
  });

  describe('repair budget (issue #9: salvage hanging through two full LLM timeouts)', () => {
    // Both attempts share ONE getLlmTimeoutMs() budget, a timed-out attempt is never
    // followed by another, and an attempt that cannot finish in the remaining time is
    // skipped. Fake timers compress the budget. The budget is DERIVED, not assumed:
    // a stray PI_RESEARCH_LLM_TIMEOUT_MS in the ambient env must not change what the
    // test measures (unit-env.ts isolates the config.env file; this covers process env).
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not launch attempt 2 after an attempt times out', async () => {
      const budget = getLlmTimeoutMs();
      // Attempt 1 never settles; the shared budget's withTimeout fires at the deadline.
      mockCompleter.mockImplementation(() => new Promise(() => {}));
      const pending = repairJsonWithLlm('{', mockCompleter, auth, { model: stubModel });
      await vi.advanceTimersByTimeAsync(budget);
      const result = await pending;
      expect(result).toBeNull();
      expect(mockCompleter).toHaveBeenCalledTimes(1); // attempt 2 never launches
      // The timeout is explained in the log, not just the raw error.
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.stringContaining('Salvage attempt timed out; not retrying')
      );
    });

    it('skips the retry when the remaining shared budget is below the attempt floor', async () => {
      const budget = getLlmTimeoutMs();
      // Attempt 1 resolves instantly but fails schema validation (normally retried);
      // the clock is then moved to 5s before the deadline — under the 30s floor.
      mockCompleter.mockImplementation(() => {
        vi.setSystemTime(Date.now() + (budget - 5_000));
        return Promise.resolve({
          ...baseMessage,
          content: [{ type: 'text', text: '{"foo":"x"}' }], // missing bar → schema fail
          stopReason: 'stop',
        });
      });
      const result = await repairJsonWithLlm('bad', mockCompleter, auth, { model: stubModel, schema });
      expect(result).toBeNull();
      expect(mockCompleter).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.stringContaining(`only 5000ms of the ${budget}ms repair budget remains`)
      );
    });

    it('still retries a schema-validation failure while budget remains', async () => {
      // Regression guard: the shared budget must not eat the legitimate retry — the
      // existing two-attempt contract for validation failures is unchanged.
      mockCompleter
        .mockResolvedValueOnce({ ...baseMessage, content: [{ type: 'text', text: '{"foo":"x"}' }], stopReason: 'stop' })
        .mockResolvedValueOnce({ ...baseMessage, content: [{ type: 'text', text: '{"foo":"x","bar":2}' }], stopReason: 'stop' });
      const result = await repairJsonWithLlm('bad', mockCompleter, auth, { model: stubModel, schema });
      expect(result).toEqual({ foo: 'x', bar: 2 });
      expect(mockCompleter).toHaveBeenCalledTimes(2);
    });
  });
});
