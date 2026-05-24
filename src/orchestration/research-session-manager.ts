/**
 * Research Session Manager
 *
 * Provides singleton access to research session services.
 * Each research run gets a dedicated service instance through this manager.
 */

import { ResearchSessionService } from './research-session-service.ts';
import { ResearchSynthesisService } from './research-synthesis-service.ts';
import { logger } from '../logger.ts';

/**
 * Service instances for the current research run
 * These are reset at the start of each new research run
 */
let currentSessionService: ResearchSessionService | null = null;
let currentSynthesisService: ResearchSynthesisService | null = null;

/**
 * Initialize services for a new research run
 * Call this at the start of each research session
 */
export function initializeResearchServices(): void {
  currentSessionService = new ResearchSessionService();
  currentSynthesisService = new ResearchSynthesisService();
  logger.debug('[ResearchSessionManager] Initialized new research services');
}

/**
 * Get the current session service
 * @throws Error if services not initialized
 */
export function getResearchSessionService(): ResearchSessionService {
  if (!currentSessionService) {
    throw new Error('Research services not initialized. Call initializeResearchServices() first.');
  }
  return currentSessionService;
}

/**
 * Get the current synthesis service
 * @throws Error if services not initialized
 */
export function getResearchSynthesisService(): ResearchSynthesisService {
  if (!currentSynthesisService) {
    throw new Error('Research services not initialized. Call initializeResearchServices() first.');
  }
  return currentSynthesisService;
}

/**
 * Cleanup and reset services for the current research run
 * Call this at the end of each research session
 */
export async function cleanupResearchServices(): Promise<void> {
  if (currentSessionService) {
    await currentSessionService.cleanup();
    currentSessionService = null;
  }
  currentSynthesisService = null;
  logger.debug('[ResearchSessionManager] Cleaned up research services');
}

/**
 * Check if services are initialized
 */
export function areResearchServicesInitialized(): boolean {
  return currentSessionService !== null && currentSynthesisService !== null;
}