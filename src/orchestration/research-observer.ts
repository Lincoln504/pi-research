/**
 * Research Observer Interface
 *
 * Defines the events emitted during the research process.
 * Used to decouple the research logic from the TUI/UI implementation.
 */

export interface ResearchObserver {
  onStart?(query: string, complexity: number): void;
  
  // Coordinator/Planning phase
  onPlanningStart?(attempt: number): void;
  onPlanningProgress?(status: string): void;
  onPlanningTokens?(tokens: number, cost: number): void;
  onPlanningSuccess?(plan: any): void;
  
  // Research phase (rounds)
  onRoundStart?(round: number): void;
  onSearchStart?(queries: string[]): void;
  onSearchProgress?(resultsCount: number): void;
  onSearchComplete?(resultsCount: number): void;
  
  // Individual researcher agents
  onResearcherStart?(id: string, name: string, goal: string): void;
  onResearcherProgress?(id: string, status?: string, tokens?: number, cost?: number): void;
  onResearcherComplete?(id: string, report: string): void;
  onResearcherFailure?(id: string, error: string): void;
  
  // Evaluation phase
  onEvaluationStart?(round: number): void;
  onEvaluationProgress?(status: string): void;
  onEvaluationTokens?(tokens: number, cost: number): void;
  onEvaluationDecision?(action: 'synthesize' | 'delegate', plan?: any, round?: number): void;
  
  // Synthesis/Completion
  onSynthesisStart?(): void;
  onComplete?(result: string): void;
  onError?(error: Error): void;
  
  // Global token/cost tracking
  onTokensConsumed?(tokens: number, cost: number): void;
}
