/**
 * Infrastructure Service Initialization Module
 *
 * This module registers all infrastructure-level services with the service registry.
 * Infrastructure services are registered by this module to avoid Core layer
 * depending on Infrastructure layer.
 */

import { registerService, getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import { SchedulerFactoryService } from './scheduler-factory-service.ts';
import { StateManagerService } from './state-manager-service.ts';
import { KnowledgeStoreService } from './knowledge-store-service.ts';
import { MetricsService } from './metrics-service.ts';
import { ProcessLifecycleService } from './process-lifecycle-service.ts';
import { GPUResourceService } from './gpu-resource-service.ts';
import { StateSessionManager } from './state-session-manager.ts';
import { StateBrowserManager } from './state-browser-manager.ts';
import { StateMetricsCollector } from './state-metrics.ts';
import { StateValidator } from './state-validator.ts';
import { WorkerPoolManager } from './browser/worker-pool-manager.ts';
import { ResearchSessionService } from '../orchestration/research-session-service.ts';
import { ResearchSynthesisService } from '../orchestration/research-synthesis-service.ts';
import { StatePathConfiguration } from './state-path-configuration.ts';
import { FileLockService } from './file-lock-service.ts';
import { StateBackupManager } from './state-backup-manager.ts';
import { logger } from '../logger.ts';

/**
 * Register all infrastructure services with the service registry
 */
export function registerInfrastructureServices(): void {
  logger.debug('[InfrastructureServiceInit] Registering infrastructure services...');

  // Register Process Lifecycle Service
  registerService(
    ServiceNames.PROCESS_LIFECYCLE,
    () => new ProcessLifecycleService(),
    {
      lazyInitialization: false, // Core infrastructure
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register State Path Configuration Service
  // Must be initialized before FileLockService and StateBackupManager
  registerService(
    ServiceNames.STATE_PATH_CONFIGURATION,
    () => new StatePathConfiguration(),
    {
      lazyInitialization: false, // Core infrastructure
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register File Lock Service
  // Depends on StatePathConfiguration
  registerService(
    ServiceNames.FILE_LOCK_SERVICE,
    async () => {
      const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION);
      return new FileLockService({
        lockFilePath: pathConfig.getLockFilePath(),
      });
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register State Backup Manager Service
  // Depends on StatePathConfiguration
  registerService(
    ServiceNames.STATE_BACKUP_MANAGER,
    async () => {
      const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION);
      return new StateBackupManager(
        pathConfig.getStateFilePath(),
        pathConfig.getBackupDirPath(),
        10 // maxBackups
      );
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Scheduler Factory Service
  // This is the factory that creates scheduler instances
  registerService(
    ServiceNames.SCHEDULER_FACTORY,
    () => new SchedulerFactoryService(),
    {
      lazyInitialization: false, // Always available
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

  // Register Writer Queue Service
  // This depends on KnowledgeStoreService being initialized
  registerService(
    ServiceNames.WRITER_QUEUE,
    async () => {
      const storeService = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
      return storeService.getWriterQueue();
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register GPU Resource Service
  // Depends on ProcessLifecycleService
  registerService(
    ServiceNames.GPU_RESOURCE_SERVICE,
    async () => {
      const processLifecycle = await getService<ProcessLifecycleService>(ServiceNames.PROCESS_LIFECYCLE);
      return new GPUResourceService({ processLifecycle });
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register State Session Manager Service
  // Depends on ProcessLifecycleService
  registerService(
    ServiceNames.STATE_SESSION_MANAGER,
    async () => {
      const processLifecycle = await getService<ProcessLifecycleService>(ServiceNames.PROCESS_LIFECYCLE);
      return new StateSessionManager(processLifecycle);
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register State Browser Manager Service
  registerService(
    ServiceNames.STATE_BROWSER_MANAGER,
    () => new StateBrowserManager(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register State Metrics Collector Service
  registerService(
    ServiceNames.STATE_METRICS_COLLECTOR,
    () => new StateMetricsCollector(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register State Validator Service
  registerService(
    ServiceNames.STATE_VALIDATOR,
    () => new StateValidator(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Worker Pool Manager Service
  registerService(
    ServiceNames.WORKER_POOL_MANAGER,
    () => new WorkerPoolManager(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Research Session Service
  registerService(
    ServiceNames.RESEARCH_SESSION_SERVICE,
    () => new ResearchSessionService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Research Synthesis Service
  registerService(
    ServiceNames.RESEARCH_SYNTHESIS_SERVICE,
    () => new ResearchSynthesisService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  logger.debug('[InfrastructureServiceInit] Infrastructure services registered');
}
