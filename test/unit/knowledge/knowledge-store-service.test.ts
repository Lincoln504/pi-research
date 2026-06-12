import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeStoreService } from '../../../src/infrastructure/knowledge-store-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/interfaces/service-names.ts';
import * as knowledge from '../../../src/knowledge/index.ts';
import * as embeddingFactory from '../../../src/infrastructure/embedding/embedding-factory.ts';
import * as coreRegistry from '../../../src/core/service-registry.ts';

vi.mock('../../../src/knowledge/index.ts', () => ({
  createKnowledgeStoreComponents: vi.fn(),
  forceDeleteKnowledgeStore: vi.fn(),
  SUPPORTED_MODELS: [{ id: 'model-1', multilingual: true }],
  getModelEmbedderConfig: vi.fn(),
  getModelChunkConfig: vi.fn(),
}));

vi.mock('../../../src/infrastructure/embedding/embedding-factory.ts', () => ({
  getEmbedder: vi.fn(),
  clearEmbeddingInstance: vi.fn(),
}));

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async (_name: any, _ctx?: any, _container?: any) => {}),
  tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
  ServiceLifecycle: {
    UNINITIALIZED: 'UNINITIALIZED',
    INITIALIZING: 'INITIALIZING',
    INITIALIZED: 'INITIALIZED',
    DISPOSING: 'DISPOSING',
    DISPOSED: 'DISPOSED',
  },
}));

describe('KnowledgeStoreService', () => {
  let service: KnowledgeStoreService;

  beforeEach(() => {
    service = new KnowledgeStoreService();
    vi.mocked(coreRegistry.getService).mockResolvedValue({
      getLockDirPath: () => '/tmp/locks'
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with correct components', async () => {
    const mockEmbedder = { getOriginalDevice: () => 'webgpu', isInitialized: () => true, getDevice: () => 'webgpu' };
    const mockStore = { close: vi.fn() };
    const mockQueue = { dispose: vi.fn() };
    
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValue({
      embedder: mockEmbedder as any,
      store: mockStore as any,
      writerQueue: mockQueue as any,
    });

    await service.initialize();

    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    expect(knowledge.createKnowledgeStoreComponents).toHaveBeenCalled();
    expect(await service.getEmbedder()).toBe(mockEmbedder);
    expect(await service.getStore()).toBe(mockStore);
    expect(await service.getWriterQueue()).toBe(mockQueue);
  });

  it('should handle LanceDB corruption and auto-recover', async () => {
    const corruptionError = new Error('Generic memory error: Invalid range 0..0');
    const mockEmbedder = { 
      getOriginalDevice: vi.fn().mockReturnValue('webgpu'), 
      isInitialized: vi.fn().mockReturnValue(true), 
      getDevice: vi.fn().mockReturnValue('webgpu'),
      dispose: vi.fn()
    };
    vi.mocked(knowledge.createKnowledgeStoreComponents)
      .mockRejectedValueOnce(corruptionError)
      .mockResolvedValueOnce({
        embedder: mockEmbedder as any,
        store: { close: vi.fn() } as any,
        writerQueue: { dispose: vi.fn() } as any,
      });

    await service.initialize();

    expect(knowledge.forceDeleteKnowledgeStore).toHaveBeenCalled();
    expect(knowledge.createKnowledgeStoreComponents).toHaveBeenCalledTimes(2);
    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
  });

  it('clearLocal should use correct workspace filter', async () => {
    const mockEmbedder = { 
      getOriginalDevice: vi.fn().mockReturnValue('webgpu'), 
      isInitialized: vi.fn().mockReturnValue(true), 
      getDevice: vi.fn().mockReturnValue('webgpu')
    };
    const mockStore = { clear: vi.fn(), close: vi.fn(), initialize: vi.fn() };
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValue({
      embedder: mockEmbedder as any,
      store: mockStore as any,
      writerQueue: { dispose: vi.fn() } as any,
    });

    await service.clearLocal();

    const expectedWorkspace = process.cwd().replace(/'/g, "''");
    expect(mockStore.clear).toHaveBeenCalledWith(`workspace = '${expectedWorkspace}'`);
  });

  it('clearGlobal should use is_global filter', async () => {
    const mockEmbedder = { 
      getOriginalDevice: vi.fn().mockReturnValue('webgpu'), 
      isInitialized: vi.fn().mockReturnValue(true), 
      getDevice: vi.fn().mockReturnValue('webgpu')
    };
    const mockStore = { clear: vi.fn(), close: vi.fn(), initialize: vi.fn() };
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValue({
      embedder: mockEmbedder as any,
      store: mockStore as any,
      writerQueue: { dispose: vi.fn() } as any,
    });

    await service.clearGlobal();

    expect(mockStore.clear).toHaveBeenCalledWith('is_global = true');
  });

  it('dispose should call dispose on all components in order', async () => {
    const mockEmbedder = { 
      dispose: vi.fn(), 
      getOriginalDevice: vi.fn().mockReturnValue('webgpu'),
      isInitialized: vi.fn().mockReturnValue(true),
      getDevice: vi.fn().mockReturnValue('webgpu')
    };
    const mockStore = { close: vi.fn(), initialize: vi.fn() };
    const mockQueue = { dispose: vi.fn() };
    
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValue({
      embedder: mockEmbedder as any,
      store: mockStore as any,
      writerQueue: mockQueue as any,
    });

    await service.initialize();
    await service.dispose();

    expect(mockQueue.dispose).toHaveBeenCalled();
    expect(mockStore.close).toHaveBeenCalled();
    expect(mockEmbedder.dispose).toHaveBeenCalled();
    expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
  });
});
