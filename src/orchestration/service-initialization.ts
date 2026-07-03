/**
 * Orchestration Service Initialization Module
 *
 * This module registers all orchestration-layer services with the service registry.
 * Encapsulating these here maintains strict layering (Infrastructure → Core ← Orchestration).
 */

import { registerService, getServiceContainer, getService, type IService } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import { ResearchOrchestrationService } from './research-orchestration-service.ts';
import { ResearchSessionService } from './research-session-service.ts';
import { ResearchSynthesisService } from './research-synthesis-service.ts';
import { HealthCheckRegistry } from '../healthcheck/registry.ts';
import { registerHealthChecks } from '../healthcheck/index.ts';
import { logger } from '../logger.ts';

/**
 * Register all orchestration services with the service registry
 */
export function registerOrchestrationServices(container: ServiceContainer = getServiceContainer()): void {
  logger.debug('[OrchestrationServiceInit] Registering orchestration services...');

  // Register Research Orchestration Service
  registerService(
    ServiceNames.RESEARCH_ORCHESTRATION,
    () => new ResearchOrchestrationService(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Research Session Service
  registerService(
    ServiceNames.RESEARCH_SESSION_SERVICE,
    () => new ResearchSessionService(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Research Synthesis Service
  registerService(
    ServiceNames.RESEARCH_SYNTHESIS_SERVICE,
    () => new ResearchSynthesisService(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Health Registry Service
  // This is registered here because it coordinates checks across layers
  registerService(
    ServiceNames.HEALTH_REGISTRY,
    async () => {
      const registry = new HealthCheckRegistry();
      await registry.initialize();
      registerHealthChecks(registry, container);
      return registry;
    },
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  logger.debug('[OrchestrationServiceInit] Orchestration services registered');
}

/**
 * Initialize all orchestration services
 */
export async function initializeOrchestrationServices(ctx?: any, container: ServiceContainer = getServiceContainer()): Promise<{ success: boolean; initialized: string[]; failed: string[] }> {
  logger.log('[OrchestrationServiceInit] Initializing orchestration services...');
  
  const servicesToInit = [
    { name: ServiceNames.RESEARCH_ORCHESTRATION, label: 'Research Orchestration Service' },
    { name: ServiceNames.RESEARCH_SESSION_SERVICE, label: 'Research Session Service' },
    { name: ServiceNames.RESEARCH_SYNTHESIS_SERVICE, label: 'Research Synthesis Service' },
    { name: ServiceNames.HEALTH_REGISTRY, label: 'Health Registry Service' },
  ];

  const initialized: string[] = [];
  const failed: string[] = [];

  for (const service of servicesToInit) {
    try {
      await getService<IService>(service.name, ctx, container);
      initialized.push(service.label);
    } catch (err) {
      const msg = `${service.label} init failed`;
      logger.error(`[OrchestrationServiceInit] ${msg}:`, err);
      failed.push(msg);
    }
  }

  return { 
    success: failed.length === 0, 
    initialized, 
    failed 
  };
}
