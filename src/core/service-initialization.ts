/**
 * Service Initialization Module
 *
 * This module registers all services with the service registry.
 * This is the central place for service configuration and initialization.
 */

import { registerService, getService, disposeAllServices } from './service-registry.ts';
import { ServiceNames } from './service-interfaces.ts';
import { SchedulerService } from './scheduler-service.ts';
import { HealthCheckService } from './health-check-service.ts';
import { BrowserManagerService } from './browser-manager-service.ts';
import { StateManagerService } from './state-manager-service.ts';
import { KnowledgeStoreService } from './knowledge-store-service.ts';
import { MetricsService } from './metrics-service.ts';
import { PlanningService } from './planning-service.ts';
import { logger } from '../logger.ts';

/**
 * Register all core services with the service registry
 */
export function registerCoreServices(): void {
  logger.debug('[ServiceInitialization] Registering core services...');

  // Register Scheduler Service
  registerService(
    ServiceNames.SCHEDULER,
    () => new SchedulerService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Health Check Cache Service
  registerService(
    ServiceNames.HEALTH_CHECK_CACHE,
    () => new HealthCheckService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Browser Manager Service
  registerService(
    ServiceNames.BROWSER_MANAGER,
    () => new BrowserManagerService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register State Manager Service
  registerService(
    ServiceNames.STATE_MANAGER,
    () => new StateManagerService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Knowledge Store Service
  registerService(
    ServiceNames.KNOWLEDGE_STORE,
    () => new KnowledgeStoreService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Metrics Service
  registerService(
    ServiceNames.METRICS,
    () => new MetricsService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Planning Service
  registerService(
    ServiceNames.PLANNING,
    () => new PlanningService(),
    {
      lazyInitialization: false, // Planning service needs to be available early
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  logger.debug('[ServiceInitialization] All core services registered');
}

/**
 * Initialize all core services
 * This is called early in the application startup
 *
 * Services are initialized in dependency order:
 * - Services marked with lazyInitialization: false are eagerly initialized
 * - Other services are initialized lazily on first use
 *
 * Note: Infrastructure services (Metrics, StateManager, HealthCheckCache, BrowserManager)
 * are always initialized early as they form the foundation for other services.
 */
export async function initializeCoreServices(): Promise<{ initialized: string[]; failed: string[] }> {
  logger.log('[ServiceInitialization] Initializing core services...');

  const initialized: string[] = [];
  const failed: string[] = [];

  // Critical infrastructure services (always initialize early)
  const criticalInfrastructure = [
    { name: ServiceNames.METRICS, label: 'Metrics Service' },
    { name: ServiceNames.STATE_MANAGER, label: 'State Manager Service' },
    { name: ServiceNames.HEALTH_CHECK_CACHE, label: 'Health Check Cache Service' },
    { name: ServiceNames.BROWSER_MANAGER, label: 'Browser Manager Service' },
  ];

  // Services requiring eager initialization (marked with lazyInitialization: false)
  const eagerServices = [
    { name: ServiceNames.PLANNING, label: 'Planning Service' },
  ];

  // Lazy services (initialized on first use)
  const lazyServices = [
    ServiceNames.SCHEDULER,
    ServiceNames.KNOWLEDGE_STORE,
  ];

  try {
    // Initialize critical infrastructure services
    logger.log('[ServiceInitialization] Initializing critical infrastructure services...');
    for (const service of criticalInfrastructure) {
      try {
        logger.debug(`[ServiceInitialization] Initializing ${service.label}...`);
        const svc = await getService<any>(service.name);
        if (svc.initialize) {
          await svc.initialize();
        }
        initialized.push(service.label);
        logger.debug(`[ServiceInitialization] ✓ ${service.label} initialized`);
      } catch (err) {
        const errorMsg = `${service.label} initialization failed`;
        logger.error(`[ServiceInitialization] ✗ ${errorMsg}:`, err);
        failed.push(errorMsg);
        // Continue with other services even if one fails
      }
    }

    // Initialize eagerly-marked services
    logger.log('[ServiceInitialization] Initializing eagerly-marked services...');
    for (const service of eagerServices) {
      try {
        logger.debug(`[ServiceInitialization] Initializing ${service.label}...`);
        const svc = await getService<any>(service.name);
        if (svc.initialize) {
          await svc.initialize();
        }
        initialized.push(service.label);
        logger.debug(`[ServiceInitialization] ✓ ${service.label} initialized`);
      } catch (err) {
        const errorMsg = `${service.label} initialization failed`;
        logger.error(`[ServiceInitialization] ✗ ${errorMsg}:`, err);
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
      logger.log(`[ServiceInitialization] ✓ All ${initialized.length} critical services initialized successfully`);
    } else {
      logger.warn(`[ServiceInitialization] ⚠ ${initialized.length}/${initialized.length + failed.length} services initialized, ${failed.length} failed`);
      for (const failure of failed) {
        logger.warn(`[ServiceInitialization]   - ${failure}`);
      }
    }

    return { initialized, failed };
  } catch (err) {
    logger.error('[ServiceInitialization] Failed to initialize core services:', err);
    throw err;
  }
}

/**
 * Dispose all core services
 * This is called during application shutdown
 */
export async function disposeCoreServices(): Promise<void> {
  logger.log('[ServiceInitialization] Disposing core services...');

  try {
    // Dispose services in reverse dependency order
    await disposeAllServices();

    logger.log('[ServiceInitialization] Core services disposed successfully');
  } catch (err) {
    logger.error('[ServiceInitialization] Failed to dispose core services:', err);
    throw err;
  }
}

