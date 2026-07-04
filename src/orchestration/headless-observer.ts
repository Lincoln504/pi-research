/**
 * Headless Research Observer
 *
 * A clean implementation of the ResearchObserver interface that forwards
 * events to callbacks or logs them, rather than updating a TUI.
 * Ideal for programmatic SDK use.
 */

import { logger } from '../logger.ts';
import type { ResearchObserver, HeadlessObserverOptions } from '../core/interfaces/observer-interfaces.ts';
import type { ResearchPlan } from '../core/interfaces/research-plan-types.ts';

export type { HeadlessObserverOptions };

/**
 * Wrap an observer so a throwing (or rejecting) callback can never corrupt a
 * research run. Observer methods are fire-and-forget notifications, but the
 * orchestrators invoke them inline at load-bearing points (researcher
 * completion, evaluation decisions, synthesis start) — an exception from
 * user-supplied SDK/TUI observer code would otherwise surface as a *research*
 * failure. HeadlessObserver already isolates its own onProgress callback; this
 * extends the same isolation to raw ResearchObserver implementations. Sync
 * throws are logged and swallowed; returned promises get a .catch so
 * rejections never become unhandled.
 */
export function makeSafeObserver<T extends object>(observer: T): T {
  return new Proxy(observer, {
    get(target, prop) {
      // Guard the ACCESS too, and resolve getters against the target (not the
      // proxy): an observer exposing a method via an accessor that touches a
      // private field would otherwise throw at `observer?.onX?.(...)` property
      // access — outside the call-site try/catch below — which is exactly the
      // failure this wrapper exists to absorb.
      let value: unknown;
      try {
        value = Reflect.get(target, prop, target);
      } catch (err) {
        logger.warn(`[observer] Ignored error reading observer.${String(prop)}:`, err);
        return undefined;
      }
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const out = value.apply(target, args);
          if (out && typeof (out as Promise<unknown>).then === 'function') {
            return (out as Promise<unknown>).catch((err: unknown) => {
              logger.warn(`[observer] Ignored rejection from observer.${String(prop)}:`, err);
            });
          }
          return out;
        } catch (err) {
          logger.warn(`[observer] Ignored error from observer.${String(prop)}:`, err);
          return undefined;
        }
      };
    },
  }) as T;
}

export class HeadlessObserver implements ResearchObserver {
  constructor(private options: HeadlessObserverOptions = {}) {}

  private emit(event: string, data?: any) {
    if (this.options.enableLogging) {
      logger.debug(`[HeadlessObserver] ${event}`, data);
    }
    // User-supplied SDK callback: a throw must not propagate into research
    // event dispatch (same isolation TuiPulse applies to its subscribers).
    try {
      this.options.onProgress?.(event, data);
    } catch (err) {
      logger.debug('[HeadlessObserver] onProgress callback threw:', err);
    }
  }

  onStart(query: string, complexity: number): void {
    this.emit('start', { query, complexity });
  }

  onPlanningStart(attempt: number): void {
    this.emit('planning_start', { attempt });
  }

  onPlanningProgress(status: string): void {
    this.emit('planning_progress', { status });
  }

  onPlanningTokens(tokens: number, cost: number): void {
    this.emit('planning_tokens', { tokens, cost });
  }

  onPlanningSuccess(plan: ResearchPlan): void {
    this.emit('planning_success', { plan });
  }

  onRoundStart(round: number): void {
    this.emit('round_start', { round });
  }

  onSearchStart(queries: string[]): void {
    this.emit('search_start', { queries });
  }

  onSearchProgress(resultsCount: number): void {
    this.emit('search_progress', { resultsCount });
  }

  onSearchComplete(resultsCount: number): void {
    this.emit('search_complete', { resultsCount });
  }

  onResearcherStart(id: string, name: string, goal: string, roundNumber?: number): void {
    this.emit('researcher_start', { id, name, goal, roundNumber });
  }

  onResearcherProgress(id: string, status?: string, tokens?: number, cost?: number): void {
    this.emit('researcher_progress', { id, status, tokens, cost });
  }

  onResearcherComplete(id: string, report: string): void {
    this.emit('researcher_complete', { id, report });
  }

  onResearcherFailure(id: string, error: string): void {
    this.emit('researcher_failure', { id, error });
  }

  onToolResult(researcherId: string, success: boolean): void {
    this.emit('tool_result', { researcherId, success });
  }

  onEvaluationStart(round: number): void {
    this.emit('evaluation_start', { round });
  }

  onEvaluationProgress(status: string): void {
    this.emit('evaluation_progress', { status });
  }

  onEvaluationTokens(tokens: number, cost: number): void {
    this.emit('evaluation_tokens', { tokens, cost });
  }

  onEvaluationDecision(action: 'synthesize' | 'delegate', plan?: ResearchPlan, round?: number): void {
    this.emit('evaluation_decision', { action, plan, round });
  }

  onComplete(result: string): void {
    this.emit('complete', { result });
  }

  onError(error: Error): void {
    this.emit('error', { message: error.message });
  }

  onTokensConsumed(tokens: number, cost: number): void {
    this.emit('tokens_consumed', { tokens, cost });
  }
}
