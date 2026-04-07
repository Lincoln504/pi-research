/**
 * Swarm Research Types
 * 
 * Defines the schema for the monolithic ResearchState persisted in the session tree.
 */

export type ResearchStatus = 'planning' | 'researching' | 'evaluating' | 'synthesizing' | 'completed' | 'failed';
export type SiblingStatus = 'pending' | 'running' | 'completed' | 'failed';

export type SwarmEvent =
  | { type: 'PLANNING_COMPLETE'; agenda: string[]; initialCount: number }
  | { type: 'SIBLING_STARTED'; id: string }
  | { type: 'SIBLING_COMPLETED'; id: string; report: string }
  | { type: 'SIBLING_FAILED'; id: string; error: string }
  | { type: 'LINKS_SCRAPED'; links: string[] }
  | { type: 'PROMOTION_STARTED'; id: string }
  | { type: 'PROMOTION_DECISION'; nextQueries: string[]; finalSynthesis?: string; maxRounds: number };

export interface ResearchSibling {
  id: string; // e.g. "1.1", "2.1"
  query: string;
  status: SiblingStatus;
  report?: string;
  error?: string;
  tokens?: number;
}

export interface SystemResearchState {
  version: 1;
  rootQuery: string;
  complexity: 1 | 2 | 3;
  currentRound: 1 | 2 | 3;
  status: ResearchStatus;
  lastUpdated: number;
  
  // The full exhaustive list of aspects planned by the initial coordinator
  initialAgenda: string[];
  
  // Global pool updated IMMEDIATELY by the scrape tool
  allScrapedLinks: string[];
  
  // Sequence of research aspects actively being worked or completed
  aspects: {
    [id: string]: ResearchSibling;
  };
  
  // Track who was promoted to Lead Evaluator in this round to prevent race conditions
  promotedId?: string;

  // Final result if completed
  finalSynthesis?: string;
}
