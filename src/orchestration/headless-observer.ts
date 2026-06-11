/**
 * Headless Research Observer
 *
 * A clean implementation of the ResearchObserver interface that forwards
 * events to callbacks or logs them, rather than updating a TUI.
 * Ideal for programmatic SDK use.
 */

import { logger } from '../logger.ts';
import type { ResearchObserver } from './research-observer.ts';
import type { ResearchPlan } from '../core/interfaces/research-plan-types.ts';

export interface HeadlessObserverOptions {
  /** Callback for progress updates */
  onProgress?: (event: string, data?: any) => void;
  /** Whether to log events to the console/logger */
  enableLogging?: boolean;
}

export class HeadlessObserver implements ResearchObserver {
  constructor(private options: HeadlessObserverOptions = {}) {}

  private emit(event: string, data?: any) {
    if (this.options.enableLogging) {
      logger.debug(`[HeadlessObserver] ${event}`, data);
    }
    this.options.onProgress?.(event, data);
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
