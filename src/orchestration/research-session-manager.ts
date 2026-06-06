/**
 * Research Session Manager
 *
 * Provides access to research session services through the service registry.
 * Services are now managed centrally instead of module-level singletons.
 */

import { getService, tryGetService } from '../core/service-registry.ts';
import { ServiceNames, type IPlanningService } from '../core/service-interfaces.ts';
import type { ResearchSessionService } from './research-session-service.ts';
import type { ResearchSynthesisService } from './research-synthesis-service.ts';
import { cleanupSharedLinks } from '../utils/shared-links.ts';
import { logger } from '../logger.ts';

/**
 * Get the current session service
 */
export async function getResearchSessionService(): Promise<ResearchSessionService> {
  return getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE);
}

/**
 * Get the current synthesis service
 */
export async function getResearchSynthesisService(): Promise<ResearchSynthesisService> {
  return getService<ResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE);
}

/**
 * Cleanup and reset services for the current research run
 * Call this at the end of each research session
 */
export async function cleanupResearchServices(sessionId?: string): Promise<void> {
  // Cleanup session service
  const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE).catch(() => null);
  if (sessionService) {
    await sessionService.cleanup(sessionId);
  }
  
  // Clear synthesis reports (ResearchSynthesisService doesn't have a cleanup method, just clearReports)
  const synthesisService = await getService<ResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE).catch(() => null);
  if (synthesisService) {
    synthesisService.clearReports(sessionId);
  }
  
  // Clear planning state to prevent accumulation across research runs
  const planningService = tryGetService<IPlanningService>(ServiceNames.PLANNING);
  if (planningService) {
    planningService.clearPlanningState(sessionId);
    logger.debug('[ResearchSessionManager] Cleared planning state');
  }
  
  if (sessionId) {
    cleanupSharedLinks(sessionId);
  }

  logger.debug('[ResearchSessionManager] Cleaned up research services');
}

/**
 * Reset services (alias for cleanup)
 */
export async function resetResearchServices(sessionId?: string): Promise<void> {
  await cleanupResearchServices(sessionId);
}