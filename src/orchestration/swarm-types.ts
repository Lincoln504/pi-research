/**
 * Swarm Research Types
 * 
 * Defines the schema for the monolithic ResearchState persisted in the session tree.
 */

export type ResearchStatus = 'planning' | 'researching' | 'evaluating' | 'synthesizing' | 'completed' | 'failed';
export type SiblingStatus = 'pending' | 'running' | 'completed' | 'failed';

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
  
  // Final result if completed
  finalSynthesis?: string;
}
