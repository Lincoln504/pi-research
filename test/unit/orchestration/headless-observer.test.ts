/**
 * HeadlessObserver Unit Tests
 *
 * Verifies that every ResearchObserver method fires the correct event name
 * and payload through the onProgress callback, and that enableLogging
 * routes events to the logger without crashing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeadlessObserver } from '../../../src/orchestration/headless-observer.ts';
import type { HeadlessObserverOptions } from '../../../src/orchestration/headless-observer.ts';
import type { ResearchPlan } from '../../../src/core/interfaces/research-plan-types.ts';

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Helpers
const STUB_PLAN: ResearchPlan = {
  action: 'delegate',
  researchers: [
    { id: '1', name: 'Researcher A', goal: 'Test goal', queries: ['q1'] },
  ],
  allQueries: ['q1'],
};

function makeObserver(opts: HeadlessObserverOptions = {}) {
  return new HeadlessObserver(opts);
}

describe('HeadlessObserver', () => {
  describe('construction', () => {
    it('constructs with no options', () => {
      expect(() => new HeadlessObserver()).not.toThrow();
    });

    it('constructs with an onProgress callback', () => {
      const cb = vi.fn();
      expect(() => new HeadlessObserver({ onProgress: cb })).not.toThrow();
    });

    it('constructs with enableLogging only', () => {
      expect(() => new HeadlessObserver({ enableLogging: true })).not.toThrow();
    });
  });

  describe('onProgress callback forwarding', () => {
    let events: Array<{ event: string; data: any }>;
    let observer: HeadlessObserver;

    beforeEach(() => {
      events = [];
      observer = makeObserver({
        onProgress: (event, data) => events.push({ event, data }),
      });
    });

    it('onStart emits "start" with query and complexity', () => {
      observer.onStart('test query', 2);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe('start');
      expect(events[0]!.data).toEqual({ query: 'test query', complexity: 2 });
    });

    it('onPlanningStart emits "planning_start" with attempt number', () => {
      observer.onPlanningStart(1);
      expect(events[0]!.event).toBe('planning_start');
      expect(events[0]!.data).toEqual({ attempt: 1 });
    });

    it('onPlanningProgress emits "planning_progress" with status string', () => {
      observer.onPlanningProgress('Generating plan...');
      expect(events[0]!.event).toBe('planning_progress');
      expect(events[0]!.data).toEqual({ status: 'Generating plan...' });
    });

    it('onPlanningTokens emits "planning_tokens" with tokens and cost', () => {
      observer.onPlanningTokens(1500, 0.03);
      expect(events[0]!.event).toBe('planning_tokens');
      expect(events[0]!.data).toEqual({ tokens: 1500, cost: 0.03 });
    });

    it('onPlanningSuccess emits "planning_success" with the full plan object', () => {
      observer.onPlanningSuccess(STUB_PLAN);
      expect(events[0]!.event).toBe('planning_success');
      expect(events[0]!.data.plan).toBe(STUB_PLAN);
    });

    it('onRoundStart emits "round_start" with round number', () => {
      observer.onRoundStart(2);
      expect(events[0]!.event).toBe('round_start');
      expect(events[0]!.data).toEqual({ round: 2 });
    });

    it('onSearchStart emits "search_start" with queries array', () => {
      observer.onSearchStart(['q1', 'q2']);
      expect(events[0]!.event).toBe('search_start');
      expect(events[0]!.data).toEqual({ queries: ['q1', 'q2'] });
    });

    it('onSearchProgress emits "search_progress" with resultsCount', () => {
      observer.onSearchProgress(12);
      expect(events[0]!.event).toBe('search_progress');
      expect(events[0]!.data).toEqual({ resultsCount: 12 });
    });

    it('onSearchComplete emits "search_complete" with resultsCount', () => {
      observer.onSearchComplete(25);
      expect(events[0]!.event).toBe('search_complete');
      expect(events[0]!.data).toEqual({ resultsCount: 25 });
    });

    it('onResearcherStart emits "researcher_start" with id, name, goal, and roundNumber', () => {
      observer.onResearcherStart('r1', 'Researcher A', 'Find facts', 2);
      expect(events[0]!.event).toBe('researcher_start');
      expect(events[0]!.data).toEqual({ id: 'r1', name: 'Researcher A', goal: 'Find facts', roundNumber: 2 });
    });

    it('onResearcherStart emits without roundNumber when omitted', () => {
      observer.onResearcherStart('r1', 'Researcher A', 'Find facts');
      expect(events[0]!.data.roundNumber).toBeUndefined();
    });

    it('onResearcherProgress emits "researcher_progress" with optional fields', () => {
      observer.onResearcherProgress('r1', 'searching', 800, 0.01);
      expect(events[0]!.event).toBe('researcher_progress');
      expect(events[0]!.data).toEqual({ id: 'r1', status: 'searching', tokens: 800, cost: 0.01 });
    });

    it('onResearcherProgress emits with only id when optional fields are absent', () => {
      observer.onResearcherProgress('r1');
      expect(events[0]!.data.id).toBe('r1');
      expect(events[0]!.data.status).toBeUndefined();
      expect(events[0]!.data.tokens).toBeUndefined();
      expect(events[0]!.data.cost).toBeUndefined();
    });

    it('onResearcherTokensHint emits "researcher_tokens_hint" with id and inputTokens', () => {
      observer.onResearcherTokensHint('r1', 12345);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe('researcher_tokens_hint');
      expect(events[0]!.data).toEqual({ id: 'r1', inputTokens: 12345 });
    });

    it('onSynthesisStart emits "synthesis_start"', () => {
      observer.onSynthesisStart();
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe('synthesis_start');
      expect(events[0]!.data).toBeUndefined();
    });

    it('onResearcherComplete emits "researcher_complete" with id and report', () => {
      observer.onResearcherComplete('r1', '## Report\nFindings...');
      expect(events[0]!.event).toBe('researcher_complete');
      expect(events[0]!.data).toEqual({ id: 'r1', report: '## Report\nFindings...' });
    });

    it('onResearcherFailure emits "researcher_failure" with id and error message', () => {
      observer.onResearcherFailure('r1', 'Network timeout');
      expect(events[0]!.event).toBe('researcher_failure');
      expect(events[0]!.data).toEqual({ id: 'r1', error: 'Network timeout' });
    });

    it('onEvaluationStart emits "evaluation_start" with round number', () => {
      observer.onEvaluationStart(1);
      expect(events[0]!.event).toBe('evaluation_start');
      expect(events[0]!.data).toEqual({ round: 1 });
    });

    it('onEvaluationProgress emits "evaluation_progress" with status string', () => {
      observer.onEvaluationProgress('Evaluating findings...');
      expect(events[0]!.event).toBe('evaluation_progress');
      expect(events[0]!.data).toEqual({ status: 'Evaluating findings...' });
    });

    it('onEvaluationTokens emits "evaluation_tokens" with tokens and cost', () => {
      observer.onEvaluationTokens(3200, 0.08);
      expect(events[0]!.event).toBe('evaluation_tokens');
      expect(events[0]!.data).toEqual({ tokens: 3200, cost: 0.08 });
    });

    it('onEvaluationDecision emits "evaluation_decision" with synthesize action', () => {
      observer.onEvaluationDecision('synthesize');
      expect(events[0]!.event).toBe('evaluation_decision');
      expect(events[0]!.data.action).toBe('synthesize');
      expect(events[0]!.data.plan).toBeUndefined();
    });

    it('onEvaluationDecision emits "evaluation_decision" with delegate action and plan', () => {
      observer.onEvaluationDecision('delegate', STUB_PLAN, 2);
      expect(events[0]!.data.action).toBe('delegate');
      expect(events[0]!.data.plan).toBe(STUB_PLAN);
      expect(events[0]!.data.round).toBe(2);
    });

    it('onComplete emits "complete" with the result string', () => {
      observer.onComplete('## Final Report\nContent here.');
      expect(events[0]!.event).toBe('complete');
      expect(events[0]!.data).toEqual({ result: '## Final Report\nContent here.' });
    });

    it('onError emits "error" with the error message (not the Error instance)', () => {
      observer.onError(new Error('Something failed'));
      expect(events[0]!.event).toBe('error');
      expect(events[0]!.data).toEqual({ message: 'Something failed' });
    });

    it('onTokensConsumed emits "tokens_consumed" with tokens and cost', () => {
      observer.onTokensConsumed(10000, 0.25);
      expect(events[0]!.event).toBe('tokens_consumed');
      expect(events[0]!.data).toEqual({ tokens: 10000, cost: 0.25 });
    });
  });

  describe('event sequence integrity', () => {
    it('records events in emission order across multiple calls', () => {
      const events: string[] = [];
      const observer = makeObserver({ onProgress: (e) => events.push(e) });

      observer.onStart('q', 1);
      observer.onPlanningStart(1);
      observer.onPlanningSuccess(STUB_PLAN);
      observer.onRoundStart(1);
      observer.onSearchStart(['q1']);
      observer.onSearchComplete(5);
      observer.onResearcherStart('r1', 'R', 'G');
      observer.onResearcherComplete('r1', 'report');
      observer.onEvaluationStart(1);
      observer.onEvaluationDecision('synthesize');
      observer.onComplete('result');

      expect(events).toEqual([
        'start',
        'planning_start',
        'planning_success',
        'round_start',
        'search_start',
        'search_complete',
        'researcher_start',
        'researcher_complete',
        'evaluation_start',
        'evaluation_decision',
        'complete',
      ]);
    });
  });

  describe('enableLogging', () => {
    it('calls logger.debug for every event when enableLogging is true', async () => {
      const { logger } = await import('../../../src/logger.ts');
      const debugSpy = vi.mocked(logger.debug);
      debugSpy.mockClear();

      const observer = makeObserver({ enableLogging: true });
      observer.onStart('test', 1);

      expect(debugSpy).toHaveBeenCalledOnce();
      const [msg] = debugSpy.mock.calls[0]!;
      expect(String(msg)).toContain('[HeadlessObserver]');
      expect(String(msg)).toContain('start');
    });

    it('does not call logger.debug when enableLogging is false', async () => {
      const { logger } = await import('../../../src/logger.ts');
      const debugSpy = vi.mocked(logger.debug);
      debugSpy.mockClear();

      const observer = makeObserver({ enableLogging: false });
      observer.onStart('test', 1);

      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('does not call logger.debug when no options are provided', async () => {
      const { logger } = await import('../../../src/logger.ts');
      const debugSpy = vi.mocked(logger.debug);
      debugSpy.mockClear();

      const observer = makeObserver();
      observer.onComplete('result');

      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('calls both logger.debug and onProgress callback when both are set', async () => {
      const { logger } = await import('../../../src/logger.ts');
      const debugSpy = vi.mocked(logger.debug);
      debugSpy.mockClear();

      const cb = vi.fn();
      const observer = makeObserver({ enableLogging: true, onProgress: cb });
      observer.onComplete('result');

      expect(debugSpy).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith('complete', { result: 'result' });
    });
  });

  describe('no-op when callback is absent', () => {
    it('none of the event methods throw when onProgress is not provided', () => {
      const observer = makeObserver();
      expect(() => {
        observer.onStart('q', 1);
        observer.onPlanningStart(1);
        observer.onPlanningProgress('status');
        observer.onPlanningTokens(100, 0.01);
        observer.onPlanningSuccess(STUB_PLAN);
        observer.onRoundStart(1);
        observer.onSearchStart(['q']);
        observer.onSearchProgress(3);
        observer.onSearchComplete(3);
        observer.onResearcherStart('r1', 'R', 'G');
        observer.onResearcherProgress('r1');
        observer.onResearcherTokensHint('r1', 100);
        observer.onResearcherComplete('r1', 'report');
        observer.onResearcherFailure('r1', 'err');
        observer.onEvaluationStart(1);
        observer.onEvaluationProgress('eval');
        observer.onEvaluationTokens(500, 0.02);
        observer.onEvaluationDecision('synthesize');
        observer.onSynthesisStart();
        observer.onComplete('done');
        observer.onError(new Error('boom'));
        observer.onTokensConsumed(1000, 0.05);
      }).not.toThrow();
    });
  });

  describe('callback isolation', () => {
    it('a throwing onProgress callback does not propagate into event dispatch', () => {
      const observer = makeObserver({
        onProgress: () => { throw new Error('SDK consumer bug'); },
      });
      expect(() => {
        observer.onStart('q', 1);
        observer.onComplete('done');
        observer.onError(new Error('boom'));
      }).not.toThrow();
    });

    it('logs the callback failure at debug and continues', async () => {
      const { logger } = await import('../../../src/logger.ts');
      vi.mocked(logger.debug).mockClear();
      const observer = makeObserver({
        onProgress: () => { throw new Error('SDK consumer bug'); },
      });
      observer.onComplete('done');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('onProgress callback threw'),
        expect.any(Error),
      );
    });
  });
});

describe('makeSafeObserver', () => {
  // The orchestrators wrap every resolved observer with this: raw
  // ResearchObserver implementations (SDK consumers, the TUI) get the same
  // throw-isolation HeadlessObserver applies to its own onProgress.
  it('swallows a sync throw from an observer method and returns undefined', async () => {
    const { makeSafeObserver } = await import('../../../src/orchestration/headless-observer.ts');
    const raw = {
      onStart: vi.fn(() => { throw new Error('display bug'); }),
      onComplete: vi.fn((r: string) => `saw ${r}`),
    };
    const safe = makeSafeObserver(raw);

    expect(() => (safe as any).onStart('q', 1)).not.toThrow();
    expect(raw.onStart).toHaveBeenCalledWith('q', 1);
    // Non-throwing methods pass through with `this` and return value intact.
    expect((safe as any).onComplete('done')).toBe('saw done');
  });

  it('attaches a catch to a rejecting async observer method (no unhandled rejection)', async () => {
    const { makeSafeObserver } = await import('../../../src/orchestration/headless-observer.ts');
    const raw = {
      onSynthesisStart: vi.fn(async () => { throw new Error('async display bug'); }),
    };
    const safe = makeSafeObserver(raw);

    await expect((safe as any).onSynthesisStart()).resolves.toBeUndefined();
    expect(raw.onSynthesisStart).toHaveBeenCalled();
  });

  it('leaves non-function properties and instanceof intact (proxy transparency)', async () => {
    const { makeSafeObserver } = await import('../../../src/orchestration/headless-observer.ts');
    const obs = new HeadlessObserver({});
    const safe = makeSafeObserver(obs);
    expect(safe instanceof HeadlessObserver).toBe(true);

    const tagged = makeSafeObserver({ tag: 'x', onStart: vi.fn() });
    expect((tagged as any).tag).toBe('x');
  });

  it('works with a frozen observer (proxy invariants must not fire at property access)', async () => {
    const { makeSafeObserver } = await import('../../../src/orchestration/headless-observer.ts');
    const onStart = vi.fn(() => { throw new Error('display bug'); });
    const frozen = Object.freeze({ onStart, onComplete: (r: string) => `saw ${r}` });
    const safe = makeSafeObserver(frozen);

    // Proxying a frozen object directly makes the engine throw TypeError at the
    // ACCESS (non-writable non-configurable own property may not be replaced by
    // a wrapper) — both lines below would fail with the naive implementation.
    expect(() => (safe as any).onStart('q', 1)).not.toThrow();
    expect(onStart).toHaveBeenCalledWith('q', 1);
    expect((safe as any).onComplete('done')).toBe('saw done');
  });
});
