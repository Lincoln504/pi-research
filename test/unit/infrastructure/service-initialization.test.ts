import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerInfrastructureServices } from '../../../src/infrastructure/service-initialization.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import * as coreRegistry from '../../../src/core/service-registry.ts';

vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return {
    ...actual,
    registerService: vi.fn(),
  };
});

vi.mock('../../../src/logger.ts', () => ({
  logger: { debug: vi.fn() },
}));

describe('Infrastructure Service Initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register all expected infrastructure services', () => {
    registerInfrastructureServices();

    const expectedServices = [
      ServiceNames.PROCESS_LIFECYCLE,
      ServiceNames.STATE_PATH_CONFIGURATION,
      ServiceNames.FILE_LOCK_SERVICE,
      ServiceNames.STATE_BACKUP_MANAGER,
      ServiceNames.SCHEDULER_FACTORY,
      ServiceNames.STATE_MANAGER,
      ServiceNames.KNOWLEDGE_STORE,
      ServiceNames.METRICS,
      ServiceNames.WRITER_QUEUE,
      ServiceNames.GPU_RESOURCE_SERVICE,
      ServiceNames.STATE_SESSION_MANAGER,
      ServiceNames.STATE_BROWSER_MANAGER,
      ServiceNames.STATE_METRICS_COLLECTOR,
      ServiceNames.STATE_VALIDATOR,
      ServiceNames.WORKER_POOL_MANAGER,
    ];

    const registeredNames = vi.mocked(coreRegistry.registerService).mock.calls.map(call => call[0]);
    
    for (const name of expectedServices) {
      expect(registeredNames).toContain(name);
    }
  });

  it('should register services with correct options', () => {
    registerInfrastructureServices();

    // Check a few specific services for correct lazyInitialization flag
    const processLifecycleCall = vi.mocked(coreRegistry.registerService).mock.calls.find(c => c[0] === ServiceNames.PROCESS_LIFECYCLE);
    expect(processLifecycleCall![2]?.lazyInitialization).toBe(false);

    const knowledgeStoreCall = vi.mocked(coreRegistry.registerService).mock.calls.find(c => c[0] === ServiceNames.KNOWLEDGE_STORE);
    expect(knowledgeStoreCall![2]?.lazyInitialization).toBe(true);
  });
});
