import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeStoreService } from '../../../src/infrastructure/knowledge-store-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';
import * as knowledge from '../../../src/knowledge/index.ts';
import * as coreRegistry from '../../../src/core/service-registry.ts';
import * as embeddingFactory from '../../../src/infrastructure/embedding/embedding-factory.ts';

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
    DISABLED: 'DISABLED',
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

  it('revives a mode-disabled store when Knowledge Mode is re-enabled in config (no restart)', async () => {
    // First init: createKnowledgeStoreComponents returns null → store disabled (mode=none).
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValueOnce(null as any);
    await service.initialize();
    expect(service.lifecycle).toBe(ServiceLifecycle.DISABLED);

    // User enables Knowledge Mode via /research-config. The next init (same cwd) must re-check
    // live config and re-initialize instead of early-returning the memoized DISABLED verdict.
    const mockEmbedder = { getOriginalDevice: () => 'cpu', isInitialized: () => true, getDevice: () => 'cpu' };
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValueOnce({
      embedder: mockEmbedder as any, store: { close: vi.fn() } as any, writerQueue: { dispose: vi.fn() } as any,
    });
    await service.initialize({ config: { KNOWLEDGE_STORE_MODE: 'global' } } as any);

    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    expect(knowledge.createKnowledgeStoreComponents).toHaveBeenCalledTimes(2);
  });

  it('stays disabled (no needless rebuild) when Knowledge Mode is still none', async () => {
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValueOnce(null as any);
    await service.initialize();
    expect(service.lifecycle).toBe(ServiceLifecycle.DISABLED);

    // Live config still 'none' → early-return, no second build.
    await service.initialize({ config: { KNOWLEDGE_STORE_MODE: 'none' } } as any);
    expect(knowledge.createKnowledgeStoreComponents).toHaveBeenCalledTimes(1);
  });

  it('re-initializes the live store when Knowledge Mode changes project→global at runtime', async () => {
    const mk = () => ({
      embedder: { getOriginalDevice: () => 'cpu', isInitialized: () => true, getDevice: () => 'cpu' } as any,
      store: { close: vi.fn() } as any,
      writerQueue: { dispose: vi.fn() } as any,
    });
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockImplementation(async () => mk());

    await service.initialize({ config: { KNOWLEDGE_STORE_MODE: 'project' } } as any);
    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    const builds = vi.mocked(knowledge.createKnowledgeStoreComponents).mock.calls.length;

    // User switches project→global via /research-config (same cwd, new mode) → dispose + rebuild.
    await service.initialize({ config: { KNOWLEDGE_STORE_MODE: 'global' } } as any);
    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    expect(vi.mocked(knowledge.createKnowledgeStoreComponents).mock.calls.length).toBe(builds + 1);
  });

  it('disables the live store when Knowledge Mode changes enabled→none at runtime', async () => {
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValueOnce({
      embedder: { getOriginalDevice: () => 'cpu', isInitialized: () => true, getDevice: () => 'cpu' } as any,
      store: { close: vi.fn() } as any,
      writerQueue: { dispose: vi.fn() } as any,
    });
    await service.initialize({ config: { KNOWLEDGE_STORE_MODE: 'global' } } as any);
    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);

    // Switch to none → dispose + rebuild → components null → DISABLED (no restart needed).
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValueOnce(null as any);
    await service.initialize({ config: { KNOWLEDGE_STORE_MODE: 'none' } } as any);
    expect(service.lifecycle).toBe(ServiceLifecycle.DISABLED);
  });

  it('lazy getStore()/getEmbedder() after an explicit-cwd init do NOT re-scope to process.cwd()', async () => {
    // Regression: getStore() calls initialize() with no ctx. It previously resolved
    // the missing cwd to process.cwd(), so when process.cwd() !== the session cwd it
    // disposed the correctly-scoped store and rebuilt it against process.cwd().
    const makeComponents = () => ({
      embedder: { getOriginalDevice: () => 'webgpu', isInitialized: () => true, getDevice: () => 'webgpu', dispose: vi.fn() } as any,
      store: { close: vi.fn() } as any,
      writerQueue: { dispose: vi.fn() } as any,
    });
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockImplementation(async () => makeComponents());

    // The session cwd is deliberately NOT process.cwd() (that is the whole point).
    const sessionCwd = '/tmp/pi-research-scope-projA';
    expect(sessionCwd).not.toBe(process.cwd());

    await service.initialize({ cwd: sessionCwd });
    expect(service.getCwd()).toBe(sessionCwd);
    const buildsAfterInit = vi.mocked(knowledge.createKnowledgeStoreComponents).mock.calls.length;
    // The store was built for the session cwd (5th positional arg).
    expect(vi.mocked(knowledge.createKnowledgeStoreComponents).mock.lastCall?.[4]).toBe(sessionCwd);

    // Lazy accessors must neither re-scope nor rebuild the store.
    await service.getStore();
    await service.getEmbedder();
    await service.getWriterQueue();

    expect(service.getCwd()).toBe(sessionCwd);
    expect(vi.mocked(knowledge.createKnowledgeStoreComponents).mock.calls.length).toBe(buildsAfterInit);
  });

  it('an explicit ctx.cwd change DOES re-scope the store to the new directory', async () => {
    const makeComponents = () => ({
      embedder: { getOriginalDevice: () => 'webgpu', isInitialized: () => true, getDevice: () => 'webgpu', dispose: vi.fn() } as any,
      store: { close: vi.fn() } as any,
      writerQueue: { dispose: vi.fn() } as any,
    });
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockImplementation(async () => makeComponents());

    await service.initialize({ cwd: '/tmp/pi-research-scope-projA' });
    await service.initialize({ cwd: '/tmp/pi-research-scope-projB' });

    expect(service.getCwd()).toBe('/tmp/pi-research-scope-projB');
    expect(vi.mocked(knowledge.createKnowledgeStoreComponents).mock.lastCall?.[4]).toBe('/tmp/pi-research-scope-projB');
    // Two distinct directories → two builds (the first store was disposed).
    expect(vi.mocked(knowledge.createKnowledgeStoreComponents).mock.calls.length).toBe(2);
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

  it('dispose clears the embedding factory cache so a later re-init cannot be handed the disposed instance', async () => {
    // The factory's getEmbedder() fast path has no liveness check: after this
    // service disposes its embedder (leader: EmbeddingServer.shutdown), the
    // module-level cache would keep serving the dead instance and a re-init
    // (cwd/mode re-scope) would burn every warm-up retry on it.
    const mockEmbedder = {
      dispose: vi.fn(),
      getOriginalDevice: vi.fn().mockReturnValue('cpu'),
      isInitialized: vi.fn().mockReturnValue(true),
      getDevice: vi.fn().mockReturnValue('cpu'),
    };
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValue({
      embedder: mockEmbedder as any,
      store: { close: vi.fn() } as any,
      writerQueue: { dispose: vi.fn() } as any,
    });

    await service.initialize();
    expect(embeddingFactory.clearEmbeddingInstance).not.toHaveBeenCalled();

    await service.dispose();
    expect(embeddingFactory.clearEmbeddingInstance).toHaveBeenCalled();
  });

  // Regression: none of initialize()'s lifecycle guards recognized DISPOSING,
  // so an initialize() call arriving while dispose() was still mid-teardown
  // would start rebuilding immediately (this.lifecycle = INITIALIZING
  // unconditionally overwrote DISPOSING). Depending on timing, that either let
  // the in-flight dispose() close/null the FRESH components the race just
  // published, or let the race resurrect the service from DISPOSED back to
  // INITIALIZED with components dispose() never got a chance to tear down.
  it('a concurrent initialize() while dispose() is still awaiting store.close() does not race the fresh components', async () => {
    let resolveFirstClose!: () => void;
    const firstCloseGate = new Promise<void>((resolve) => { resolveFirstClose = resolve; });

    const firstEmbedder = {
      dispose: vi.fn().mockResolvedValue(undefined),
      getOriginalDevice: () => 'cpu', isInitialized: () => true, getDevice: () => 'cpu',
    };
    const firstStore = { close: vi.fn(() => firstCloseGate) };
    const firstQueue = { dispose: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValueOnce({
      embedder: firstEmbedder as any, store: firstStore as any, writerQueue: firstQueue as any,
    });
    await service.initialize();
    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);

    const secondEmbedder = {
      dispose: vi.fn().mockResolvedValue(undefined),
      getOriginalDevice: () => 'cpu', isInitialized: () => true, getDevice: () => 'cpu',
    };
    const secondStore = { close: vi.fn().mockResolvedValue(undefined) };
    const secondQueue = { dispose: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(knowledge.createKnowledgeStoreComponents).mockResolvedValueOnce({
      embedder: secondEmbedder as any, store: secondStore as any, writerQueue: secondQueue as any,
    });

    // dispose() runs up to (and blocks on) firstStore.close() before yielding
    // control back here — a concurrent initialize() must wait it out rather
    // than starting a second build immediately.
    const disposePromise = service.dispose();
    const initPromise = service.initialize();

    resolveFirstClose();
    await disposePromise;
    await initPromise;

    // dispose() tore down exactly the components it was invoked for — never
    // the ones the racing initialize() built.
    expect(firstStore.close).toHaveBeenCalledTimes(1);
    expect(secondStore.close).not.toHaveBeenCalled();
    expect(firstEmbedder.dispose).toHaveBeenCalledTimes(1);
    expect(secondEmbedder.dispose).not.toHaveBeenCalled();

    // The service ends up INITIALIZED with the fresh (second) components —
    // not DISPOSED with everything nulled, and not stuck serving the stale
    // first components.
    expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    expect(await service.getStore()).toBe(secondStore);
    expect(await service.getEmbedder()).toBe(secondEmbedder);
  });
});
