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

  it('should register services with an options object (and no dead lazyInitialization flag)', () => {
    registerInfrastructureServices();

    const processLifecycleCall = vi.mocked(coreRegistry.registerService).mock.calls.find(c => c[0] === ServiceNames.PROCESS_LIFECYCLE);
    const knowledgeStoreCall = vi.mocked(coreRegistry.registerService).mock.calls.find(c => c[0] === ServiceNames.KNOWLEDGE_STORE);

    // Both are registered with real options; eager-vs-lazy is driven by the
    // init-time eagerServices/criticalInfrastructure lists, not a per-registration
    // flag — the removed lazyInitialization must not reappear here.
    for (const call of [processLifecycleCall, knowledgeStoreCall]) {
      expect(call).toBeDefined();
      expect(call![2]).toBeDefined();
      expect('lazyInitialization' in (call![2] as object)).toBe(false);
    }
  });
});
