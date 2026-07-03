/**
 * Research Panel Types
 *
 * Type definitions for the research TUI panel.
 */

/**
 * Local Theme interface — mirrors pi-tui Theme.fg()
 */
export interface Theme {
  fg: (color: any, text: string) => string;
}

export interface SliceState {
  id: string;
  label: string; // Displayed label: "1", "2", "3", etc.
  completed: boolean;
  queued: boolean;
  tokens?: number; // Tokens for this specific agent
  cost?: number;   // Cost for this specific agent
  status?: string; // Optional status message like "Searching..."
  /** Active flash color — set by flashSlice, cleared by timeout. Always present. */
  flash: 'green' | 'red' | null;
  /** Terminal outcome: true if this researcher failed (retries exhausted / no links).
   *  Rendered distinctly (error color + "failed" marker) so a failed researcher is not
   *  visually identical to a successful one — a completed slice is otherwise drawn muted. */
  failed?: boolean;
}

export interface ResearchProgress {
  /** Total tool calls expected across all researchers in the initial plan. */
  expected: number;
  /** Actual tool calls completed so far. */
  made: number;
}

export interface ResearchPanelState {
  sessionId: string;
  /** Alias for sessionId — used by the orchestrator */
  researchId: string;
  query: string;
  slices: Map<string, SliceState>;
  modelName: string;
  /** True when the research is actively searching (queueing/executing search tool) */
  isSearching?: boolean;
  /** Optional progress bar data. Set after planning completes. */
  progress?: ResearchProgress;
  /** Animation frame counter for traveling wave effect during search */
  waveFrame?: number;
  /** Last-visit frame per position for wave animation decay */
  waveColors?: number[];
  /** Timer for wave animation */
  waveTimer?: NodeJS.Timeout | null;
  /** Flag indicating whether completed researchers should be cleared */
  needsClear?: boolean;
  /** 1-2 word topic title derived from the query after the coordinator LLM responds */
  title?: string;
  /** Whether the current research phase can accept steering messages.
   * True during search/researcher phases. False during coordinator/evaluator LLM calls and after completion. */
  steeringAcceptable?: boolean;
}