import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHealthCheck, registerHealthChecks, isBusyPoolHealthFailure } from '../../../src/healthcheck/index.ts';
import { HealthCheckRegistry } from '../../../src/healthcheck/registry.ts';
import { isBrowserAvailable } from '../../../src/infrastructure/browser/config.ts';
import { runBrowserHealthCheck } from '../../../src/infrastructure/browser/task-execution-service.ts';
import { registerService, resetServiceContainer, getService, ServiceLifecycle } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { getConfig } from '../../../src/config.ts';

// Mock dependencies. getConfig is a vi.fn so individual tests can override the
// KNOWLEDGE_STORE_MODE to exercise the non-disabled health path.
vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    HEALTH_CHECK_TIMEOUT_MS: 25000,
    KNOWLEDGE_STORE_MODE: 'none'
  })),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// The availability probe decides which 'disabled' wording the store health check
// reports: packages-not-resolvable (with the package names) vs the platform
// capability line. Mock it so these tests never depend on whether the running
// host happens to have the optional ML deps installed — npm/cli#4828 drops them
// intermittently, which would flip the wording and redden the wording-pinning
// assertions below at random.
const mockProbe = { available: true, missing: [] as string[] };
vi.mock('../../../src/knowledge/availability.ts', () => ({
  probeKnowledgeStoreAvailability: vi.fn(() => mockProbe),
}));

vi.mock('../../../src/infrastructure/browser/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/infrastructure/browser/config.ts')>();
  return {
    ...actual,
    isBrowserAvailable: vi.fn(),
    // resolveHeadlessMode is called inside checkBrowserCapability() to decide whether
    // to gate on Xvfb. Default to returning true (non-virtual) so existing tests that
    // don't care about Xvfb checking are not affected.
    resolveHeadlessMode: vi.fn().mockReturnValue(true),
    // getHealthCheckBudgetMs is left as the REAL implementation — the new regression
    // test below exercises registerHealthChecks' use of it against a real config.
  };
});

vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runBrowserHealthCheck: vi.fn(),
}));

vi.mock('../../../src/infrastructure/knowledge-store-service.ts', () => ({
  KnowledgeStoreService: vi.fn().mockImplementation(() => ({
    name: 'knowledge-store',
    lifecycle: ServiceLifecycle.INITIALIZED,
    isReady: () => true,
    getCwd: () => process.cwd(),
    async initialize() {},
    async dispose() {},
    async getEmbedder() {
      return {
        isInitialized: () => false,
        getDevice: () => 'cpu',
        getOriginalDevice: () => 'cpu',
      };
    },
    async getStore() { 
        return {
            countScoped: async () => ({ local: 0, global: 0, projects: 0 })
        }; 
    },
  })),
}));

vi.mock('../../../src/infrastructure/state/state-manager.ts', () => ({
  StateManager: vi.fn().mockImplementation(() => ({
    name: 'state-manager',
    lifecycle: ServiceLifecycle.INITIALIZED,
    async initialize() {},
    async dispose() {},
    async getMetrics() {
      return { activeSessions: 0 };
    },
    async getGpuOwner() {
      return null;
    },
  })),
}));

describe('healthcheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default probe verdict too: clearAllMocks keeps the
    // vi.fn(() => mockProbe) implementation, but a previous test's
    // packages-missing mutation must not leak into the next test.
    mockProbe.available = true;
    mockProbe.missing = [];
    // clearAllMocks clears call history but not implementations set via
    // mockReturnValue, so restore the default 'none' config each test.
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'none',
    } as any);

    // Register mock services
    registerService(
      ServiceNames.SCHEDULER,
      () => ({
        name: 'scheduler',
        lifecycle: ServiceLifecycle.INITIALIZED,
        async initialize() {},
        async dispose() {},
        async runSearch() { return []; },
        async runScrape() { return { html: '' }; },
        async runHealthCheck() { return { success: true }; },
        async shutdown() {},
        getSchedulerInstance() { return { name: 'test-scheduler' }; },
        getSchedulerVersion() { return '1.0.0'; },
        getSchedulerInitializationPromise() { return null; },
        setSchedulerVersion() {},
        setSchedulerInitializationPromise() {},
        isSchedulerRestartInProgress() { return false; },
        setSchedulerRestartInProgress() {},
        setSchedulerInstance() {},
        isReady() { return true; },
        schedulerId: 'test',
      }),
      { allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.HEALTH_REGISTRY,
      async () => {
        const registry = new HealthCheckRegistry();
        await registry.initialize();
        registerHealthChecks(registry);
        return registry;
      },
      { allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => ({
        name: 'knowledge-store',
        lifecycle: ServiceLifecycle.INITIALIZED,
        isReady: () => true,
        getCwd: () => process.cwd(),
        async initialize() {},
        async dispose() {},
        async getEmbedder() {
          return {
            isInitialized: () => false,
            getDevice: () => 'cpu',
            getOriginalDevice: () => 'cpu',
          };
        },
        async getStore() { return {}; },
      }),
      { allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.STATE_MANAGER,
      () => ({
        name: 'state-manager',
        lifecycle: ServiceLifecycle.INITIALIZED,
        async initialize() {},
        async dispose() {},
        async getMetrics() {
          return { activeSessions: 0 };
        },
        async getGpuOwner() {
          return null;
        },
      }),
      { allowOverwrite: true, enableLogging: false }
    );
  });

  afterEach(() => {
    resetServiceContainer();
  });

  it('should pass health check when browser pool reports success', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });

    const result = await runHealthCheck();

    expect(result.success).toBe(true);
    expect(result.status).toBe('healthy');
  });

  it('StateManager diagnostic does not report a "sessions" count — nothing in production ever populates it', async () => {
    // Regression: the diagnostic used to include `sessions: stats.activeSessions`
    // from stateManager.getMetrics(). The session-tracking API that would ever
    // populate state.sessions (addSession/removeSession/updateHeartbeat) has no
    // production caller anywhere in the codebase, so this was permanently 0 —
    // presented as if it were live data.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });

    const result = await runHealthCheck();

    const stateManagerCheck = result.components?.find(c => c.component === 'StateManager');
    expect(stateManagerCheck?.healthy).toBe(true);
    expect(stateManagerCheck?.diagnostic).not.toHaveProperty('sessions');
  });

  it('should fail when browser is not available and not in mock mode', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(false);
    // Ensure mock env vars are absent so mock-mode bypass doesn't fire.
    delete process.env['PI_RESEARCH_MOCK_SEARCH'];
    delete process.env['PI_RESEARCH_MOCK_SCRAPE'];

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('browser');
  });

  it('should pass BrowserCapability in full mock mode even when isBrowserAvailable returns false', async () => {
    // In mock mode (both MOCK vars set), the browser pool is replaced by mocks —
    // it IS "available", just not backed by a real Camoufox binary.
    vi.mocked(isBrowserAvailable).mockReturnValue(false);
    process.env['PI_RESEARCH_MOCK_SEARCH'] = 'true';
    process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
    try {
      const result = await runHealthCheck();
      expect(result.success).toBe(true);
      const browserCap = result.components?.find(c => c.component === 'BrowserCapability');
      expect(browserCap?.healthy).toBe(true);
      expect(browserCap?.diagnostic?.['status']).toBe('mocked');
    } finally {
      delete process.env['PI_RESEARCH_MOCK_SEARCH'];
      delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
    }
  });

  it('reports the knowledge store UNHEALTHY when the embedding server is unreachable', async () => {
    // A remote embedding-server client reports isInitialized()===true even when the
    // server is dead. With the store enabled, the health check must probe the
    // server's liveness (fetchHealth) and surface a failure rather than a false ready.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'project',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => ({
        name: 'knowledge-store',
        lifecycle: ServiceLifecycle.INITIALIZED,
        isReady: () => true,
        getCwd: () => process.cwd(),
        async initialize() {},
        async dispose() {},
        async getEmbedder() {
          return {
            isInitialized: () => true, // client always claims ready...
            getDevice: () => 'cpu',
            getOriginalDevice: () => 'cpu',
            // ...but the liveness probe fails because the server is down.
            fetchHealth: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:7070'); },
          };
        },
        async getStore() {
          return { countScoped: async () => ({ local: 0, global: 0, projects: 0 }) };
        },
      }),
      { allowOverwrite: true, enableLogging: false }
    );

    // force: a non-forced check no longer force-initializes the store (it reports
    // idle on a cold store); actively probing the embedding server's liveness is a
    // forced operation, and is also what an already-initialized store does on a
    // normal check.
    const result = await runHealthCheck({ force: true });

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(false);
    expect(ks?.error).toMatch(/unreachable|ECONNREFUSED/i);
  });

  it('reports the knowledge store DISABLED (healthy) when the native vector stack is unavailable on this platform', async () => {
    // Platforms without a prebuilt native binding (e.g. Intel macOS / darwin-x64:
    // no onnxruntime-node binary, no @lancedb native binding) throw when the store
    // is resolved. That is a permanent capability gap, not a fault: the store must
    // degrade to disabled so a fresh user (default KNOWLEDGE_STORE_MODE='global')
    // is not blocked from research by an optional cache.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'global',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    // Resolving the knowledge-store service throws the canonical lancedb error.
    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => {
        throw new Error(
          'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).'
        );
      },
      { allowOverwrite: true, enableLogging: false }
    );

    // force: resolving the store is what surfaces the native-binding failure; a
    // non-forced check reports idle without resolving (see the idle-path test below).
    const result = await runHealthCheck({ force: true });

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(true);
    expect(String(ks?.diagnostic?.['status'])).toMatch(/native embedding\/vector stack unavailable/i);
    // The degraded store must NOT drag overall health to unhealthy.
    expect(result.status).not.toBe('unhealthy');
  });

  it('names the missing PACKAGES when the store is OFF because they are not installed', async () => {
    // A skipped optional dep (@huggingface/transformers) or a broken lancedb
    // install is a package gap, not a platform gap: 'native embedding/vector
    // stack unavailable on this platform' sent users platform-hunting when the
    // actual fix was one npm install. The probe-resolvable case must name the
    // package; a package that resolves but fails to LOAD keeps the platform line.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'global',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    mockProbe.available = false;
    mockProbe.missing = ['@huggingface/transformers'];
    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => {
        throw new Error(
          'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).'
        );
      },
      { allowOverwrite: true, enableLogging: false }
    );

    const result = await runHealthCheck({ force: true });

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(true);
    const status = String(ks?.diagnostic?.['status']);
    expect(status).toMatch(/required packages not resolvable/i);
    expect(status).toContain('@huggingface/transformers');
    expect(result.status).not.toBe('unhealthy');
  });

  it('reports the knowledge store idle (ready) WITHOUT resolving/initializing it on a non-forced check', async () => {
    // Fix A: a non-forced health check must not resolve a cold store (resolving runs
    // the LanceDB open + ONNX model load + WebGPU probe). It reports a cheap idle
    // status via the non-initializing tryGet(), exactly like the BrowserRuntime check.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'global',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    // The factory throws if ever invoked — proving a non-forced check never resolves it.
    const factory = vi.fn(() => { throw new Error('store must not be initialized by a non-forced health check'); });
    registerService(ServiceNames.KNOWLEDGE_STORE, factory, { allowOverwrite: true, enableLogging: false });

    const result = await runHealthCheck(); // non-forced

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(true);
    expect(String(ks?.diagnostic?.['status'])).toBe('ready (idle)');
    expect(factory).not.toHaveBeenCalled();
    expect(result.status).not.toBe('unhealthy');
  });

  it('idle path labels a MODE-disabled store "disabled" — never a native-platform failure', async () => {
    // A store DISABLED for reason 'mode' (Knowledge Mode was none) is revivable and
    // says nothing about the platform. The idle path must not mislabel it as
    // "native stack unavailable" on a perfectly capable host (the A1 diagnostic bug).
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'global',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => {
        // Mirror the real service: initialize() self-sets DISABLED, which the
        // registry preserves (service-registry.ts:528) instead of forcing INITIALIZED.
        const svc: any = {
          name: 'knowledge-store',
          lifecycle: ServiceLifecycle.DISABLED,
          getDisabledReason: () => 'mode',
          isReady: () => false,
          getCwd: () => process.cwd(),
          async initialize() { svc.lifecycle = ServiceLifecycle.DISABLED; },
          async dispose() {},
        };
        return svc;
      },
      { allowOverwrite: true, enableLogging: false }
    );
    // Resolve so tryGet() sees the (disabled) instance — a real store gets resolved by first use.
    await getService(ServiceNames.KNOWLEDGE_STORE);

    const result = await runHealthCheck(); // non-forced -> idle path

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(true);
    expect(String(ks?.diagnostic?.['status'])).toBe('disabled');
    expect(result.status).not.toBe('unhealthy');
  });

  it('idle path labels a NATIVE-disabled store with the probe verdict — package names when packages are missing', async () => {
    // Same verdict rule as the forced path: a 'native' disable names the missing
    // packages when the probe can attribute the gap (one npm install fixes it),
    // and keeps the platform line only when every package resolves. Forced and
    // idle paths must never disagree for the same host.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'global',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    mockProbe.available = false;
    mockProbe.missing = ['@lancedb/lancedb'];
    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => {
        const svc: any = {
          name: 'knowledge-store',
          lifecycle: ServiceLifecycle.DISABLED,
          getDisabledReason: () => 'native',
          isReady: () => false,
          getCwd: () => process.cwd(),
          async initialize() { svc.lifecycle = ServiceLifecycle.DISABLED; },
          async dispose() {},
        };
        return svc;
      },
      { allowOverwrite: true, enableLogging: false }
    );
    await getService(ServiceNames.KNOWLEDGE_STORE);

    const result = await runHealthCheck(); // non-forced -> idle path

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(true);
    const status = String(ks?.diagnostic?.['status']);
    expect(status).toMatch(/required packages not resolvable/i);
    expect(status).toContain('@lancedb/lancedb');
    expect(result.status).not.toBe('unhealthy');
  });

  it('FORCED check on a native-unavailable platform reports disabled (healthy), not a false UNHEALTHY', async () => {
    // On e.g. Intel macOS the service does NOT throw from getService: initialize()
    // memoizes the native failure as DISABLED and resolves fine. The forced path
    // used to fall through to the getEmbedder() null check and report
    // {healthy:false, error:'Embedder service not available'} — contradicting the
    // non-forced path's correct "disabled (native ...)" verdict for the same host.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'global',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => {
        const svc: any = {
          name: 'knowledge-store',
          lifecycle: ServiceLifecycle.DISABLED,
          getDisabledReason: () => 'native',
          isReady: () => false,
          getCwd: () => process.cwd(),
          async initialize() { svc.lifecycle = ServiceLifecycle.DISABLED; },
          async dispose() {},
          // A DISABLED service degrades getStore/getEmbedder to null — the exact
          // shape that used to trip the false-unhealthy path.
          async getStore() { return null; },
          async getEmbedder() { return null; },
        };
        return svc;
      },
      { allowOverwrite: true, enableLogging: false }
    );

    const result = await runHealthCheck({ force: true });

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(true);
    expect(String(ks?.diagnostic?.['status'])).toMatch(/native embedding\/vector stack unavailable/i);
    expect(result.status).not.toBe('unhealthy');
  });

  it('idle path reports a DISPOSED service as disposed (not running), never "ready (idle)"', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'global',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    const svc: any = {
      name: 'knowledge-store',
      lifecycle: ServiceLifecycle.INITIALIZED,
      isReady: () => true,
      getCwd: () => process.cwd(),
      async initialize() {},
      async dispose() {},
    };
    registerService(ServiceNames.KNOWLEDGE_STORE, () => svc, { allowOverwrite: true, enableLogging: false });
    await getService(ServiceNames.KNOWLEDGE_STORE);
    // Teardown happened (dispose ran) but the container still holds the instance.
    svc.lifecycle = ServiceLifecycle.DISPOSED;

    const result = await runHealthCheck(); // non-forced -> idle path, must not re-init

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(true);
    expect(String(ks?.diagnostic?.['status'])).toBe('disposed (not running)');
    expect(result.status).not.toBe('unhealthy');
  });

  it('embedding-server outage on the OPTIONAL knowledge cache degrades health but does NOT abort', async () => {
    // T1 regression: the KnowledgeStore is "the optional cache" research must run
    // without (see the darwin-x64 design comments in src/healthcheck/index.ts). When
    // its embedding server is down the check must still REPORT the outage, but as a
    // non-critical degradation: overall success stays true and no ECONNREFUSED leaks
    // into runHealthCheck().error — previously the TUI fed that raw string to its
    // browser-oriented formatter and aborted the run with a bogus "check your
    // internet connection" diagnosis.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'global',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => ({
        name: 'knowledge-store',
        lifecycle: ServiceLifecycle.INITIALIZED,
        isReady: () => true,
        getCwd: () => process.cwd(),
        async initialize() {},
        async dispose() {},
        async getEmbedder() {
          return {
            isInitialized: () => true,
            getDevice: () => 'cpu',
            getOriginalDevice: () => 'cpu',
            // Dead embedding server: the liveness probe refuses the connection.
            fetchHealth: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:7070'); },
          };
        },
        async getStore() {
          return { countScoped: async () => ({ local: 0, global: 0, projects: 0 }) };
        },
      }),
      { allowOverwrite: true, enableLogging: false }
    );
    // Resolve so the NON-forced already-initialized path runs the liveness probe —
    // exactly what the TUI pre-flight check (ensureFunctionalHealth) hits mid-session.
    await getService(ServiceNames.KNOWLEDGE_STORE);

    const result = await runHealthCheck(); // non-forced, as the TUI pre-flight calls it

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(false); // the outage IS still reported...
    expect(result.status).toBe('degraded'); // ...but only degrades the aggregate
    expect(result.success).toBe(true); // research proceeds without the optional cache
    expect(result.error).toBeUndefined(); // no store error to misattribute downstream
  });

  it('should fail when browser pool health check fails', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: false });

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('Browser healthcheck failed');
  });

  it('should fail when browser pool health check throws', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockRejectedValue(new Error('connection refused'));

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('connection refused');
  });

  it('does not abort a slow-but-healthy probe at the old fixed 150s floor when raised timeouts derive a larger budget', async () => {
    // Regression: registerHealthChecks wrapped BrowserRuntime in a hardcoded
    // Math.max(healthTimeoutMs, 150000), ignoring getHealthCheckBudgetMs() entirely.
    // At raised timeouts (legal up to 120_000 each per the config schema) the derived
    // budget — the one runBrowserHealthCheck's own scheduler call is armed against —
    // comfortably exceeds 150s, so a probe that is merely slow (a busy pool, not a
    // wedge) used to be aborted by this OUTER race before the inner check could ever
    // return, reporting a healthy pool as unhealthy one call-frame further out than
    // the mechanism this release built to prevent exactly that.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 60000,
      SEARCH_TIMEOUT_MS: 120000,
      SCRAPE_TIMEOUT_MS: 120000,
      BROWSER_TASK_TIMEOUT_MS: 20000,
      KNOWLEDGE_STORE_MODE: 'none',
    } as any);
    // Derived budget here is 140_000 (longest slot hold) + 180_000 (3 nav attempts at
    // max(10_000, 60_000)) = 320_000ms — comfortably past the old fixed 150_000 floor.
    vi.mocked(runBrowserHealthCheck).mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ success: true }), 200_000))
    );

    vi.useFakeTimers();
    try {
      const pending = runHealthCheck({ force: true });

      // Past the old fixed floor: the buggy version rejects here with "Health check
      // timed out after 150000ms", well before the probe (200_000ms) ever resolves.
      await vi.advanceTimersByTimeAsync(150_001);

      // Let the probe itself resolve.
      await vi.advanceTimersByTimeAsync(50_000);
      const result = await pending;

      const runtime = result.components?.find(c => c.component === 'BrowserRuntime');
      expect(runtime?.healthy).toBe(true);
      expect(result.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isBusyPoolHealthFailure', () => {
  const busyRuntime = { component: 'BrowserRuntime', healthy: false, error: 'Browser healthcheck failed: Health check timed out after 105000ms (including queue wait)' };
  const okCapability = { component: 'BrowserCapability', healthy: true };

  it('returns true when capability is healthy and only BrowserRuntime timed out (pool busy)', () => {
    expect(isBusyPoolHealthFailure({ components: [okCapability, busyRuntime] })).toBe(true);
  });

  it('returns true when capability entry is absent but the only failure is a runtime timeout', () => {
    expect(isBusyPoolHealthFailure({ components: [busyRuntime] })).toBe(true);
  });

  it('returns false when BrowserCapability itself is unhealthy (browser not installed)', () => {
    expect(isBusyPoolHealthFailure({ components: [
      { component: 'BrowserCapability', healthy: false, error: 'Camoufox not found' },
      busyRuntime,
    ] })).toBe(false);
  });

  it('returns false when BrowserRuntime failed for a non-timeout reason (real failure)', () => {
    expect(isBusyPoolHealthFailure({ components: [
      okCapability,
      { component: 'BrowserRuntime', healthy: false, error: 'worker reported failure or page failed to load' },
    ] })).toBe(false);
  });

  it('returns true when runtime AND state-manager both time out under load (capability healthy)', () => {
    // The dominant real-world pattern: sustained pool/GPU contention queues out the
    // runtime probe and a second probe together. Both are timeouts → still "busy".
    expect(isBusyPoolHealthFailure({ components: [
      okCapability,
      busyRuntime,
      { component: 'StateManager', healthy: false, error: 'Health check timed out after 25000ms' },
    ] })).toBe(true);
  });

  it('returns false when a co-failing component has a NON-timeout error (real fault)', () => {
    expect(isBusyPoolHealthFailure({ components: [
      okCapability,
      busyRuntime,
      { component: 'KnowledgeStore', healthy: false, error: 'Embedder service not available' },
    ] })).toBe(false);
  });

  it('returns false when there are no unhealthy components', () => {
    expect(isBusyPoolHealthFailure({ components: [okCapability, { component: 'BrowserRuntime', healthy: true }] })).toBe(false);
  });

  it('returns false on an empty/missing components list', () => {
    expect(isBusyPoolHealthFailure({})).toBe(false);
    expect(isBusyPoolHealthFailure({ components: [] })).toBe(false);
  });
});
