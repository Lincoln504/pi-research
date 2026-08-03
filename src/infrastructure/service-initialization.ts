/**
 * Infrastructure Service Initialization Module
 *
 * This module registers all infrastructure-level services with the service registry.
 * Infrastructure services are registered by this module to avoid Core layer
 * depending on Infrastructure layer.
 */

import { registerService, getService, disposeAllServices, type IService, getServiceContainer } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IKnowledgeStoreService } from '../core/service-interfaces.ts';
import { SchedulerFactoryService } from './scheduler-factory-service.ts';
import { StateManagerService } from './state/state-manager-service.ts';
import { MetricsService } from './metrics-service.ts';
import { ProcessLifecycleService } from './process-lifecycle-service.ts';
import { GPUResourceService } from './gpu-resource-service.ts';
import { StateSessionManager } from './state/state-session-manager.ts';
import { StateBrowserManager } from './state/state-browser-manager.ts';
import { StateMetricsCollector } from './state/state-metrics.ts';
import { StateValidator } from './state/state-validator.ts';
import { WorkerPoolManager } from './browser/worker-pool-manager.ts';
import { StatePathConfiguration } from './state/state-path-configuration.ts';
import { FileLockService } from './file-lock-service.ts';
import { ResearchRunSemaphore } from './research-run-semaphore.ts';
import { StateBackupManager } from './state/state-backup-manager.ts';
import { logger } from '../logger.ts';

/**
 * Register all infrastructure services with the service registry
 */
export function registerInfrastructureServices(container: ServiceContainer = getServiceContainer()): void {
  logger.debug('[InfrastructureServiceInit] Registering infrastructure services...');

  // Register Process Lifecycle Service
  registerService(
    ServiceNames.PROCESS_LIFECYCLE,
    () => new ProcessLifecycleService(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register State Path Configuration Service
  // Must be initialized before FileLockService and StateBackupManager
  registerService(
    ServiceNames.STATE_PATH_CONFIGURATION,
    () => new StatePathConfiguration(process.env['PI_RESEARCH_STATE_DIR']),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register File Lock Service
  // Depends on StatePathConfiguration
  registerService(
    ServiceNames.FILE_LOCK_SERVICE,
    async () => {
      const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION, undefined, container);
      const processLifecycle = await getService<ProcessLifecycleService>(ServiceNames.PROCESS_LIFECYCLE, undefined, container);
      return new FileLockService({
        lockFilePath: pathConfig.getLockFilePath(),
        processLifecycle,
      });
    },
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Research Run Semaphore (Phase 1 cross-process run-cap).
  // Depends on StatePathConfiguration (slot dir) and ProcessLifecycle (PID-reuse-safe
  // reclamation). Lazy: only built on first research run. Acquired at runResearch()
  // entry; released in its finally. A bug here fails OPEN (research proceeds) so it
  // can never break research; genuine capacity exhaustion fails fast with a clear error.
  registerService(
    ServiceNames.RESEARCH_RUN_SEMAPHORE,
    async () => {
      const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION, undefined, container);
      const processLifecycle = await getService<ProcessLifecycleService>(ServiceNames.PROCESS_LIFECYCLE, undefined, container);
      return new ResearchRunSemaphore(pathConfig.getStateDir(), processLifecycle);
    },
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register State Backup Manager Service
  // Depends on StatePathConfiguration
  registerService(
    ServiceNames.STATE_BACKUP_MANAGER,
    async () => {
      const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION, undefined, container);
      return new StateBackupManager(
        pathConfig.getStateFilePath(),
        pathConfig.getBackupDirPath(),
        10 // maxBackups
      );
    },
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Scheduler Factory Service
  // This is the factory that creates scheduler instances
  registerService(
    ServiceNames.SCHEDULER_FACTORY,
    () => new SchedulerFactoryService(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register State Manager Service
  registerService(
    ServiceNames.STATE_MANAGER,
    () => new StateManagerService(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Knowledge Store Service.
  // Loaded via dynamic import so the native ML/vector stack
  // (@huggingface/transformers / onnxruntime-node, @lancedb/lancedb) is only
  // pulled in when the store is actually requested — never at extension load.
  // The default mode is 'global', but this factory is still fully lazy: it only
  // runs the first time the store is actually accessed (a scrape cache-check or
  // write), so startup stays native-free. When KNOWLEDGE_STORE_MODE is 'none'
  // this factory never runs at all.
  registerService(
    ServiceNames.KNOWLEDGE_STORE,
    async () => {
      const { KnowledgeStoreService } = await import('./knowledge-store-service.ts');
      return new KnowledgeStoreService();
    },
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Metrics Service
  registerService(
    ServiceNames.METRICS,
    () => new MetricsService(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Writer Queue Service
  // This depends on KnowledgeStoreService being initialized
  registerService(
    ServiceNames.WRITER_QUEUE,
    async () => {
      const storeService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, undefined, container);
      const queue = await storeService.getWriterQueue();
      if (!queue) {
        throw new Error('Writer queue is disabled in configuration');
      }
      return queue;
    },
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register GPU Resource Service
  // Depends on ProcessLifecycleService
  registerService(
    ServiceNames.GPU_RESOURCE_SERVICE,
    async () => {
      const processLifecycle = await getService<ProcessLifecycleService>(ServiceNames.PROCESS_LIFECYCLE, undefined, container);
      return new GPUResourceService({ processLifecycle });
    },
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register State Session Manager Service
  // Depends on ProcessLifecycleService
  registerService(
    ServiceNames.STATE_SESSION_MANAGER,
    async () => {
      const processLifecycle = await getService<ProcessLifecycleService>(ServiceNames.PROCESS_LIFECYCLE, undefined, container);
      return new StateSessionManager(processLifecycle);
    },
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register State Browser Manager Service
  registerService(
    ServiceNames.STATE_BROWSER_MANAGER,
    () => new StateBrowserManager(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register State Metrics Collector Service
  registerService(
    ServiceNames.STATE_METRICS_COLLECTOR,
    () => new StateMetricsCollector(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register State Validator Service
  registerService(
    ServiceNames.STATE_VALIDATOR,
    () => new StateValidator(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  // Register Worker Pool Manager Service
  registerService(
    ServiceNames.WORKER_POOL_MANAGER,
    () => new WorkerPoolManager(),
    {
      allowOverwrite: false,
      enableLogging: true,
    },
    container
  );

  logger.debug('[InfrastructureServiceInit] Infrastructure services registered');
}

/**
 * Initialize all infrastructure services
 * 
 * @param ctx - Optional extension context
 * @param container - Service container instance
 */
export async function initializeInfrastructureServices(ctx?: any, container: ServiceContainer = getServiceContainer()): Promise<{ success: boolean; initialized: string[]; failed: string[] }> {
  logger.log('[InfrastructureServiceInit] Initializing infrastructure services...');
  
  const initialized: string[] = [];
  const failed: string[] = [];
  
  // Infrastructure services that should be eagerly initialized
  const eagerServices = [
    { name: ServiceNames.PROCESS_LIFECYCLE, label: 'Process Lifecycle' },
    { name: ServiceNames.STATE_PATH_CONFIGURATION, label: 'Path Configuration' },
    { name: ServiceNames.STATE_MANAGER, label: 'State Manager' },
    { name: ServiceNames.METRICS, label: 'Metrics' },
  ];

  for (const service of eagerServices) {
    try {
      await getService<IService>(service.name, ctx, container);
      initialized.push(service.label);
    } catch (err) {
      const msg = `${service.label} init failed`;
      logger.error(`[InfrastructureServiceInit] ${msg}:`, err);
      failed.push(msg);
    }
  }

  return { 
    success: failed.length === 0, 
    initialized, 
    failed 
  };
}

/**
 * Shutdown all infrastructure services
 * 
 * @param container - Service container instance
 */
export async function shutdownInfrastructureServices(container: ServiceContainer = getServiceContainer()): Promise<void> {
  logger.log('[InfrastructureServiceInit] Shutting down infrastructure services...');
  await disposeAllServices(container);
}
