/**
 * SDK Lifecycle Unit Tests
 *
 * Covers the programmatic SDK surface: initResearchSDK, runDeepResearch,
 * runQuickResearch, and shutdownResearchSDK.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted stubs ───────────────────────

const { mockDeepRun, mockQuickRun, mockSetLogger, mockCreateLogger } = vi.hoisted(() => ({
  mockDeepRun: vi.fn().mockResolvedValue('deep result'),
  mockQuickRun: vi.fn().mockResolvedValue('quick result'),
  mockSetLogger: vi.fn(),
  mockCreateLogger: vi.fn().mockReturnValue({ verbose: true }),
}));

const { mockModelRegistryInstance, STUB_MODEL } = vi.hoisted(() => {
  const stubModel = { id: 'test-model', provider: 'test-provider' };
  const instance = {
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'mock-key' }),
    hasConfiguredAuth: vi.fn().mockReturnValue(true),
    getAll: vi.fn().mockReturnValue([stubModel]),
    getAvailable: vi.fn().mockReturnValue([stubModel]),
    find: vi.fn().mockReturnValue(stubModel),
    refresh: vi.fn(),
  };
  return { mockModelRegistryInstance: instance, STUB_MODEL: stubModel };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/orchestration/service-initialization.ts', () => ({
  registerOrchestrationServices: vi.fn(),
}));

vi.mock('../../src/core/service-initialization.ts', () => ({
  registerCoreServices: vi.fn(),
  initializeCoreServices: vi.fn().mockResolvedValue({ success: true, initialized: [], failed: [] }),
  disposeCoreServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/infrastructure/service-initialization.ts', () => ({
  registerInfrastructureServices: vi.fn(),
  initializeInfrastructureServices: vi.fn().mockResolvedValue({ success: true, initialized: [], failed: [] }),
  shutdownInfrastructureServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/shutdown-manager.ts', () => ({
  shutdownManager: {
    runCleanup: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/service-registry.ts')>();
  return {
    ...actual,
    resetServiceContainer: vi.fn().mockResolvedValue(undefined),
    getServiceContainer: vi.fn().mockReturnValue({ isReady: false }),
    createServiceContainer: vi.fn().mockReturnValue({ isReady: false, register: vi.fn() }),
    getService: vi.fn().mockImplementation((name, _ctx, _container) => {
      if (name === 'research-orchestration') return { runResearch: mockDeepRun };
      if (name === 'session-service') return { registerSession: vi.fn(), cleanup: vi.fn() };
      if (name === 'research-synthesis-service') return { getAllReports: vi.fn().mockResolvedValue(new Map()), appendMetadata: vi.fn((result: string) => result) };
      return {};
    }),
    tryGetService: vi.fn().mockImplementation((name) => {
      if (name === 'research-orchestration') return { runResearch: mockDeepRun };
      return {};
    }),
    tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
    disposeAllServices: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRegistry: {
    create: vi.fn().mockReturnValue(mockModelRegistryInstance),
    inMemory: vi.fn().mockReturnValue(mockModelRegistryInstance),
  },
  AuthStorage: {
    create: vi.fn().mockReturnValue({}),
    inMemory: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createResearchRunId: () => 'test-run-id',
  createLogger: mockCreateLogger,
  setLogger: mockSetLogger,
  resetLogger: vi.fn(),
}));

vi.mock('../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    DEFAULT_RESEARCH_DEPTH: 1,
    LOCAL_KNOWLEDGE_STORE_ENABLED: false,
    GLOBAL_KNOWLEDGE_STORE_ENABLED: false,
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_TIMEOUT_MS: 120000,
  })),
  setConfig: vi.fn(),
  validateConfig: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import {
  initResearchSDK,
  runDeepResearch,
  shutdownResearchSDK,
} from '../../src/sdk.ts';
import { 
  registerCoreServices, 
  initializeCoreServices, 
} from '../../src/core/service-initialization.ts';
import { 
  registerInfrastructureServices, 
} from '../../src/infrastructure/service-initialization.ts';
import { 
  registerOrchestrationServices, 
} from '../../src/orchestration/service-initialization.ts';
import { logger } from '../../src/logger.ts';
import { getConfig } from '../../src/config.ts';
import { resetServiceContainer, disposeAllServices } from '../../src/core/service-registry.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function initSDK(opts: Record<string, any> = {}) {
  await initResearchSDK({ model: STUB_MODEL as any, ...opts });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SDK Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeepRun.mockClear().mockResolvedValue('deep result');
    mockQuickRun.mockClear().mockResolvedValue('quick result');
    mockSetLogger.mockClear();
    mockCreateLogger.mockClear().mockReturnValue({ verbose: true });
    
    vi.mocked(registerCoreServices).mockClear();
    vi.mocked(registerInfrastructureServices).mockClear();
    vi.mocked(registerOrchestrationServices).mockClear();
    vi.mocked(initializeCoreServices).mockClear().mockResolvedValue({ success: true, initialized: [], failed: [] } as any);
    vi.mocked(disposeAllServices).mockClear().mockResolvedValue(undefined);
    vi.mocked(resetServiceContainer).mockClear().mockResolvedValue(undefined);
    vi.mocked(getConfig).mockClear().mockReturnValue({
        DEFAULT_RESEARCH_DEPTH: 1,
        LOCAL_KNOWLEDGE_STORE_ENABLED: false,
        GLOBAL_KNOWLEDGE_STORE_ENABLED: false,
        MAX_CONCURRENT_RESEARCHERS: 3,
        RESEARCHER_TIMEOUT_MS: 120000,
    } as any);
  });

  afterEach(async () => {
    await shutdownResearchSDK();
  });

  describe('initResearchSDK', () => {
    it('registers core, infrastructure, and orchestration services', async () => {
      await initSDK();
      expect(registerCoreServices).toHaveBeenCalledOnce();
      expect(registerInfrastructureServices).toHaveBeenCalledOnce();
      expect(registerOrchestrationServices).toHaveBeenCalledOnce();
    });

    it('calls initializeCoreServices with a context object', async () => {
      await initSDK();
      expect(initializeCoreServices).toHaveBeenCalledOnce();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx).toHaveProperty('modelRegistry');
      expect(ctx).toHaveProperty('cwd');
    });

    it('loads config for the correct directory', async () => {
      await initSDK({ cwd: '/custom/path' });
      expect(getConfig).toHaveBeenCalledWith('/custom/path');
    });

    it('warns and returns early when called a second time without disposing', async () => {
      await initSDK();
      vi.mocked(registerCoreServices).mockClear();
      vi.mocked(registerOrchestrationServices).mockClear();
      await initSDK();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
      expect(registerCoreServices).not.toHaveBeenCalled();
      expect(registerOrchestrationServices).not.toHaveBeenCalled();
    });

    it('uses process.cwd() when no cwd option is provided', async () => {
      await initSDK();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.cwd).toBe(process.cwd());
    });

    it('uses the provided cwd option', async () => {
      await initSDK({ cwd: '/custom/path' });
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.cwd).toBe('/custom/path');
    });
  });

  describe('runDeepResearch', () => {
    it('returns the string result from the orchestrator', async () => {
      await initSDK();
      const result = await runDeepResearch('q');
      expect(result).toBe('deep result');
    });
  });
});
