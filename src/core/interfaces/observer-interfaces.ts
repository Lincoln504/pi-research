/**
 * Observer Interfaces
 *
 * Defines the ResearchObserver interface used by the planning service and
 * orchestration layer to emit research lifecycle events. Lives in core/interfaces
 * so both planning-interfaces.ts and the orchestration layer can import it
 * without creating a circular dependency.
 */

import type { ResearchPlan } from './research-plan-types.ts';
export interface HeadlessObserverOptions {
  /** Callback for progress updates */
  onProgress?: (event: string, data?: any) => void;
  /** Whether to log events to the console/logger */
  enableLogging?: boolean;
}

export interface ResearchObserver {
  onStart?(query: string, complexity: number): void;

  /**
   * Fired once when the run cannot start immediately because every concurrent-run
   * slot is held, and it is about to queue. Without this a queued run is silent
   * for as long as the acquire wait allows, which is indistinguishable from a hang.
   * @param slots  the machine-wide concurrent-run cap
   * @param maxWaitMs how long the run will queue before giving up
   */
  onRunQueued?(slots: number, maxWaitMs: number): void;

  // Coordinator/Planning phase
  onPlanningStart?(attempt: number): void;
  onPlanningProgress?(status: string): void;
  onPlanningTokens?(tokens: number, cost: number): void;
  onPlanningSuccess?(plan: ResearchPlan): void;

  // Research phase (rounds)
  onRoundStart?(round: number): void;
  onSearchStart?(queries: string[]): void;
  onSearchProgress?(resultsCount: number): void;
  onSearchComplete?(resultsCount: number): void;

  // Individual researcher agents
  onResearcherStart?(id: string, name: string, goal: string, roundNumber?: number): void;
  onResearcherProgress?(id: string, status?: string, tokens?: number, cost?: number): void;
  onResearcherTokensHint?(id: string, inputTokens: number): void;
  onResearcherComplete?(id: string, report: string): void;
  onResearcherFailure?(id: string, error: string): void;

  /** Per-URL or per-tool-action result feedback (triggers TUI flash). */
  onToolResult?(researcherId: string, success: boolean): void;

  // Evaluation phase
  onEvaluationStart?(round: number): void;
  onEvaluationProgress?(status: string): void;
  onEvaluationTokens?(tokens: number, cost: number): void;
  onEvaluationDecision?(action: 'synthesize' | 'delegate', plan?: ResearchPlan, round?: number): void;

  // Synthesis/Completion
  /**
   * Fired when the run enters FINAL synthesis / stops consuming steering:
   *   - deep mode: right before the forced (mustSynthesize) evaluator call, and
   *     on the evaluator-chose-synthesize path (idempotent there — the flag is
   *     already off via onEvaluationDecision('synthesize')).
   *   - quick mode: as soon as the researcher session settles, i.e. the point
   *     the 500ms steering-consume poller stops running.
   * TUI consequence: steeringAcceptable flips false, so a late steer takes the
   * fall-through path (forwarded to pi with an accurate toast) instead of being
   * queued for a "next round" that will never happen.
   */
  onSynthesisStart?(): void;
  onComplete?(result: string): void;
  onError?(error: Error): void;

  // Global token/cost tracking
  onTokensConsumed?(tokens: number, cost: number): void;
}
