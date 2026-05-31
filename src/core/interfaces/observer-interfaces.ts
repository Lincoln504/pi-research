/**
 * Observer Interfaces
 *
 * Defines the ResearchObserver interface used by the planning service and
 * orchestration layer to emit research lifecycle events. Lives in core/interfaces
 * so both planning-interfaces.ts and the orchestration layer can import it
 * without creating a circular dependency.
 */

import type { ResearchPlan } from './research-plan-types.ts';

export interface ResearchObserver {
  onStart?(query: string, complexity: number): void;

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

  // Evaluation phase
  onEvaluationStart?(round: number): void;
  onEvaluationProgress?(status: string): void;
  onEvaluationTokens?(tokens: number, cost: number): void;
  onEvaluationDecision?(action: 'synthesize' | 'delegate', plan?: ResearchPlan, round?: number): void;

  // Synthesis/Completion
  onComplete?(result: string): void;
  onError?(error: Error): void;

  // Global token/cost tracking
  onTokensConsumed?(tokens: number, cost: number): void;
}
