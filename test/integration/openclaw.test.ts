import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 1. Mock orchestrators at top level
vi.mock('../../src/orchestration/quick-research-orchestrator.ts', () => ({
  QuickResearchOrchestrator: vi.fn().mockImplementation(function() {
    return {
      run: vi.fn().mockResolvedValue('integrated research report'),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('../../src/orchestration/deep-research-orchestrator.ts', () => ({
  DeepResearchOrchestrator: vi.fn().mockImplementation(function() {
    return {
      run: vi.fn().mockResolvedValue('integrated research report'),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

// 2. Mock core initialization
vi.mock('../../src/core/service-initialization.ts', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    initializeCoreServices: vi.fn().mockResolvedValue({ failed: [], success: ['KNOWLEDGE_STORE'] }),
    disposeCoreServices: vi.fn().mockResolvedValue(undefined),
  };
});

// 3. Mock ModelRegistry
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const mockRegistry = {
    find: vi.fn().mockReturnValue({ id: 'mock-model', provider: 'mock-provider', info: { contextWindow: 128000 } }),
    getAll: vi.fn().mockReturnValue([{ id: 'mock-model', provider: 'mock-provider' }]),
    getAvailable: vi.fn().mockReturnValue([{ id: 'mock-model', provider: 'mock-provider' }]),
    hasConfiguredAuth: vi.fn().mockReturnValue(true),
  };
  return {
    ...actual,
    ModelRegistry: {
      create: vi.fn().mockReturnValue(mockRegistry),
      inMemory: vi.fn().mockReturnValue(mockRegistry),
    },
    AuthStorage: { inMemory: vi.fn().mockReturnValue({}), create: vi.fn().mockReturnValue({}) },
    SettingsManager: { inMemory: vi.fn().mockReturnValue({}), create: vi.fn().mockReturnValue({}) },
    SessionManager: { inMemory: vi.fn().mockReturnValue({}) },
    createReadToolDefinition: vi.fn().mockReturnValue({ name: 'read' }),
    createGrepToolDefinition: vi.fn().mockReturnValue({ name: 'grep' }),
    createAgentSession: vi.fn().mockReturnValue({}),
  };
});

// 4. Mock Health Registry
vi.mock('../../src/healthcheck/registry.ts', async () => ({
    healthRegistry: {
        runAll: vi.fn().mockResolvedValue({ status: 'healthy', components: [] }),
        register: vi.fn(),
    }
}));

import plugin from '../../src/openclaw-entry.ts';
import { resetConfig } from '../../src/config.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Extract the allowed-value set from a JSON-schema property regardless of whether
// it is expressed as `enum: [...]` or `anyOf: [{const: ...}]` — the runtime schema
// and the manifest use different-but-equivalent encodings for the same constraint.
function allowedValues(prop: any): unknown[] | null {
  if (!prop) return null;
  if (Array.isArray(prop.enum)) return [...prop.enum].sort();
  if (Array.isArray(prop.anyOf)) {
    const consts = prop.anyOf.map((s: any) => s?.const).filter((c: any) => c !== undefined);
    return consts.length ? consts.sort() : null;
  }
  return null;
}

describe('OpenClaw config schema parity', () => {
  // The plugin is loaded by the OpenClaw host two ways at once: dist/openclaw-entry.js
  // supplies the runtime configSchema used to validate (safeParse) plugin settings,
  // while openclaw.plugin.json is the manifest the host reads for the config UI and
  // setup. If they drift, a setting accepted by one is rejected/hidden by the other.
  // This test fails loudly on any divergence so the two can never silently separate.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../openclaw.plugin.json'), 'utf-8'),
  );
  const runtime = (plugin as any).configSchema?.jsonSchema;
  const manifestProps = manifest.configSchema.properties as Record<string, any>;
  const runtimeProps = runtime?.properties as Record<string, any>;

  it('exposes a runtime JSON schema with properties', () => {
    expect(runtimeProps).toBeTruthy();
  });

  it('has identical property names in runtime schema and manifest', () => {
    expect(Object.keys(runtimeProps).sort()).toEqual(Object.keys(manifestProps).sort());
  });

  it('agrees on type, default, bounds, and allowed values for every property', () => {
    for (const key of Object.keys(manifestProps)) {
      const m = manifestProps[key];
      const r = runtimeProps[key];
      expect(r, `runtime schema missing property ${key}`).toBeTruthy();
      expect(r.default, `default mismatch for ${key}`).toEqual(m.default);
      expect(r.minimum, `minimum mismatch for ${key}`).toEqual(m.minimum);
      expect(r.maximum, `maximum mismatch for ${key}`).toEqual(m.maximum);
      expect(allowedValues(r), `allowed-value mismatch for ${key}`).toEqual(allowedValues(m));
    }
  });

  it('declares every manifest contract tool in the registered plugin', async () => {
    const registered: string[] = [];
    await plugin.register({
      registerTool: (t: any) => registered.push(t.name),
      lifecycle: { registerRuntimeLifecycle: () => {} },
      pluginConfig: {},
    } as any);
    expect(registered.sort()).toEqual([...manifest.contracts.tools].sort());
  });
});

describe('OpenClaw Plugin Integration', () => {
  let tmpDir: string;
  let registeredTools: any[] = [];
  let registeredLifecycles: any[] = [];
  
  const mockApi = {
    registerTool: (tool: any) => registeredTools.push(tool),
    lifecycle: {
      registerRuntimeLifecycle: (lifecycle: any) => registeredLifecycles.push(lifecycle),
    },
    pluginConfig: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfig();
    tmpDir = path.join(os.tmpdir(), `pi-openclaw-it-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    registeredTools = [];
    registeredLifecycles = [];
  });

  afterEach(async () => {
    // Run all registered lifecycles to trigger shutdown
    for (const lc of registeredLifecycles) {
      if (lc.cleanup) await lc.cleanup();
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should initialize and provide tools', async () => {
    expect(plugin.id).toBe('pi-research');
    await plugin.register(mockApi as any);
    expect(registeredTools).toHaveLength(3);
  });

  it('should execute research via OpenClaw interface', async () => {
    await plugin.register(mockApi as any);
    const researchTool = registeredTools.find(t => t.name === 'research')!;
    
    // Simulate openclaw context by injecting config into the mock API
    mockApi.pluginConfig = { apiKey: 'test', provider: 'mock', model: 'mock-model' };
    
    const result = await researchTool.execute('call-id', { query: 'test', depth: 0 });
    expect(result.content[0]!.text).toBe('integrated research report');
  });

  it('should respect reportExportEnabled', async () => {
    await plugin.register(mockApi as any);
    const researchTool = registeredTools.find(t => t.name === 'research')!;
    const exportCwd = path.join(tmpDir, 'project');
    fs.mkdirSync(exportCwd, { recursive: true });

    mockApi.pluginConfig = { 
        apiKey: 'test', 
        provider: 'mock', 
        model: 'mock-model', 
        reportExportEnabled: true,
        reportExportPath: exportCwd
    };

    // Note: OpenClaw tools don't take context as 3rd arg in the new API.
    // They read config. We can mock process.cwd in tests, or rely on reportExportPath config
    const originalCwd = process.cwd;
    process.cwd = () => exportCwd;

    try {
        const result = await researchTool.execute('call-id', { query: 'test', depth: 0 });
        expect(result.content[0]!.text).toContain('integrated research report');
        expect(result.content[0]!.text).toContain('Research report saved to');
    } finally {
        process.cwd = originalCwd;
    }
  });

  it('should handle health check', async () => {
    await plugin.register(mockApi as any);
    const healthTool = registeredTools.find(t => t.name === 'health')!;
    const result = await healthTool.execute('call-id', {});
    // OpenClaw now delegates to the shared health tool, which renders the same
    // Markdown report as the pi extension / SDK (not raw JSON).
    expect(result.content[0]!.text).toContain('System Health Status');
  });

  it('initializes services exactly once under concurrent tool calls', async () => {
    // Regression for the init race: research + health firing together (or two
    // researches) must not each run full service registration/startup. The
    // in-flight _initPromise guard coalesces them onto a single init.
    const { initializeCoreServices } = await import('../../src/core/service-initialization.ts');
    vi.mocked(initializeCoreServices).mockClear();

    await plugin.register(mockApi as any);
    mockApi.pluginConfig = { apiKey: 'test', provider: 'mock', model: 'mock-model' };
    const research = registeredTools.find(t => t.name === 'research')!;
    const health = registeredTools.find(t => t.name === 'health')!;

    await Promise.all([
      research.execute('c1', { query: 'a', depth: 0 }),
      health.execute('c2', {}),
      research.execute('c3', { query: 'b', depth: 0 }),
    ]);

    expect(initializeCoreServices).toHaveBeenCalledTimes(1);
  });
});
