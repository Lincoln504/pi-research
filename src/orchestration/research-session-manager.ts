/**
 * Research Session Manager
 *
 * Provides access to research session services through the service registry.
 * Services are now managed centrally instead of module-level singletons.
 */

import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { ResearchSessionService } from './research-session-service.ts';
import type { ResearchSynthesisService } from './research-synthesis-service.ts';
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
export async function cleanupResearchServices(): Promise<void> {
  const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE).catch(() => null);
  if (sessionService) {
    await sessionService.cleanup();
  }
  // Note: ResearchSynthesisService doesn't have a cleanup method, just clearReports
  const synthesisService = await getService<ResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE).catch(() => null);
  if (synthesisService) {
    synthesisService.clearReports();
  }
  logger.debug('[ResearchSessionManager] Cleaned up research services');
}

/**
 * Reset services (alias for cleanup)
 */
export async function resetResearchServices(): Promise<void> {
  await cleanupResearchServices();
}