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
import type { MetricsService as IMetricsService } from './metrics-service.ts';
import type { StateManagerService as IStateManagerService } from './state-manager-service.ts';
import type { BrowserManagerService as IBrowserManagerService } from './browser-manager-service.ts';
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

  logger.debug('[ServiceInitialization] All core services registered');
}

/**
 * Initialize all core services
 * This is called early in the application startup
 */
export async function initializeCoreServices(): Promise<void> {
  logger.log('[ServiceInitialization] Initializing core services...');

  try {
    // Initialize services in dependency order
    // 1. Metrics (no dependencies)
    const metricsService = await getService<IMetricsService>(ServiceNames.METRICS);
    await metricsService.initialize();

    // 2. State Manager (no dependencies)
    const stateManagerService = await getService<IStateManagerService>(ServiceNames.STATE_MANAGER);
    await stateManagerService.initialize();

    // 3. Health Check Cache (no dependencies)
    await getService(ServiceNames.HEALTH_CHECK_CACHE);

    // 4. Scheduler (depends on State Manager)
    // Scheduler initializes lazily on first use

    // 5. Browser Manager (depends on Scheduler)
    const browserManagerService = await getService<IBrowserManagerService>(ServiceNames.BROWSER_MANAGER);
    await browserManagerService.initialize();

    // 6. Knowledge Store (no hard dependencies, but uses State Manager for GPU lock)
    // Knowledge store initializes lazily on first use

    logger.log('[ServiceInitialization] Core services initialized successfully');
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

