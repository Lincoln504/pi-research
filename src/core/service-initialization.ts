/**
 * Service Initialization Module
 *
 * This module registers all services with the service registry.
 * This is the central place for service configuration and initialization.
 */

import { registerService, getService, disposeAllServices, type IService, getServiceContainer } from './service-registry.ts';
import type { ServiceContainer } from './service-registry.ts';
import { ServiceNames } from './service-interfaces.ts';
import type { IStateManager } from './interfaces/state-manager-interfaces.ts';
import { SchedulerService } from './scheduler-service.ts';
import { HealthCheckService } from './health-check-service.ts';
import { PlanningService } from './planning-service.ts';
import { logger } from '../logger.ts';

/**
 * Register all core services with the service registry
 */
export function registerCoreServices(container: ServiceContainer = getServiceContainer()): void {
  logger.debug('[ServiceInitialization] Registering core services...');

  // Register Scheduler Service
  registerService(
    ServiceNames.SCHEDULER,
    () => new SchedulerService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Health Check Cache Service
  registerService(
    ServiceNames.HEALTH_CHECK_CACHE,
    () => new HealthCheckService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Planning Service
  registerService(
    ServiceNames.PLANNING,
    () => new PlanningService(),
    {
      lazyInitialization: false, // Planning service needs to be available early
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  logger.debug('[ServiceInitialization] All core services registered');
}

/**
 * Initialize all core services
 * This is called early in the application startup
 *
 * @param ctx - Optional extension context to pass to services
 * @param container - Service container instance
 */
export async function initializeCoreServices(ctx?: any, container: ServiceContainer = getServiceContainer()): Promise<{ success: boolean; initialized: string[]; failed: string[] }> {
  logger.log('[ServiceInitialization] Initializing core services...');

  const initialized: string[] = [];
  const failed: string[] = [];

  // Critical infrastructure services (always initialize early)
  const criticalInfrastructure = [
    { name: ServiceNames.METRICS, label: 'Metrics Service' },
    { name: ServiceNames.PROCESS_LIFECYCLE, label: 'Process Lifecycle Service' },
    { name: ServiceNames.STATE_PATH_CONFIGURATION, label: 'State Path Configuration' },
    { name: ServiceNames.FILE_LOCK_SERVICE, label: 'File Lock Service' },
    { name: ServiceNames.STATE_BACKUP_MANAGER, label: 'State Backup Manager' },
    { name: ServiceNames.STATE_SESSION_MANAGER, label: 'State Session Manager' },
    { name: ServiceNames.STATE_BROWSER_MANAGER, label: 'State Browser Manager' },
    { name: ServiceNames.STATE_METRICS_COLLECTOR, label: 'State Metrics Collector' },
    { name: ServiceNames.STATE_VALIDATOR, label: 'State Validator' },
    { name: ServiceNames.GPU_RESOURCE_SERVICE, label: 'GPU Resource Service' },
    { name: ServiceNames.STATE_MANAGER, label: 'State Manager Service' },
    { name: ServiceNames.HEALTH_CHECK_CACHE, label: 'Health Check Cache Service' },
    { name: ServiceNames.HEALTH_REGISTRY, label: 'Health Registry Service' },
  ];

  // Services requiring eager initialization (marked with lazyInitialization: false)
  const eagerServices = [
    { name: ServiceNames.PLANNING, label: 'Planning Service' },
  ];

  // Lazy services (initialized on first use)
  const lazyServices = [
    ServiceNames.SCHEDULER,
    ServiceNames.KNOWLEDGE_STORE,
    ServiceNames.RESEARCH_ORCHESTRATION,
    ServiceNames.WORKER_POOL_MANAGER,
  ];

  try {
    // Initialize critical infrastructure services
    logger.log('[ServiceInitialization] Initializing critical infrastructure services...');
    for (const service of criticalInfrastructure) {
      try {
        logger.debug(`[ServiceInitialization] Initializing ${service.label}...`);
        // getService will call initialize(ctx) if not already initialized
        await getService<IService>(service.name, ctx, container);
        initialized.push(service.label);
        logger.debug(`[ServiceInitialization] ${service.label} initialized`);
      } catch (err) {
        const errorMsg = `${service.label} initialization failed`;
        logger.error(`[ServiceInitialization] FAILED: ${errorMsg}:`, err);
        failed.push(errorMsg);
        // Continue with other services even if one fails
      }
    }

    // Initialize eagerly-marked services
    logger.log('[ServiceInitialization] Initializing eagerly-marked services...');
    for (const service of eagerServices) {
      try {
        logger.debug(`[ServiceInitialization] Initializing ${service.label}...`);
        await getService<IService>(service.name, ctx, container);
        initialized.push(service.label);
        logger.debug(`[ServiceInitialization] ${service.label} initialized`);
      } catch (err) {
        const errorMsg = `${service.label} initialization failed`;
        logger.error(`[ServiceInitialization] FAILED: ${errorMsg}:`, err);
        failed.push(errorMsg);
        // Continue with other services even if one fails
      }
    }

    // Log lazy services that will be initialized on demand
    if (lazyServices.length > 0) {
      logger.log(`[ServiceInitialization] ${lazyServices.length} services configured for lazy initialization: ${lazyServices.join(', ')}`);
    }

    // Log summary
    if (failed.length === 0) {
      logger.log(`[ServiceInitialization] All ${initialized.length} critical services initialized successfully`);
    } else {
      logger.warn(`[ServiceInitialization] WARNING: ${initialized.length}/${initialized.length + failed.length} services initialized, ${failed.length} failed`);
      for (const failure of failed) {
        logger.warn(`[ServiceInitialization]   - ${failure}`);
      }
    }

    return { success: failed.length === 0, initialized, failed };
  } catch (err) {
    logger.error('[ServiceInitialization] Failed to initialize core services:', err);
    throw err;
  }
}

/**
 * Dispose all core services
 * This is called during application shutdown
 * 
 * @param container - Service container instance
 */
export async function disposeCoreServices(container: ServiceContainer = getServiceContainer()): Promise<void> {
  logger.log('[ServiceInitialization] Disposing core services...');

  try {
    // Clear embedding server registration before parallel disposal so the
    // EmbeddingServer can deregister itself while the StateManager is still alive.
    try {
      const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER, undefined, container);
      await stateManager.clearEmbeddingServer();
      logger.debug('[ServiceInitialization] Cleared embedding server state before disposal');
    } catch {
      // Non-fatal: embedding server state will be cleaned up on next startup via PID check
    }

    // Dispose services in reverse dependency order
    await disposeAllServices(container);

    logger.log('[ServiceInitialization] Core services disposed successfully');
  } catch (err) {
    logger.error('[ServiceInitialization] Failed to dispose core services:', err);
    throw err;
  }
}
