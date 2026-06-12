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
    createReadTool: vi.fn().mockReturnValue({ name: 'read' }),
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

import plugin, { shutdown } from '../../src/openclaw-entry.ts';
import { resetConfig } from '../../src/config.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('OpenClaw Plugin Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    resetConfig();
    tmpDir = path.join(os.tmpdir(), `pi-openclaw-it-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await shutdown();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should initialize and provide tools', () => {
    expect(plugin.id).toBe('pi-research');
    expect(plugin.tools).toHaveLength(3);
  });

  it('should execute research via OpenClaw interface', async () => {
    const researchTool = plugin.tools.find(t => t.name === 'research')!;
    const result = await researchTool.execute(
        { query: 'test', depth: 0 }, 
        { apiKey: 'test', provider: 'mock', model: 'mock-model' }, 
        {}
    );
    expect(result).toBe('integrated research report');
  });

  it('should respect reportExportEnabled', async () => {
    const researchTool = plugin.tools.find(t => t.name === 'research')!;
    const exportCwd = path.join(tmpDir, 'project');
    fs.mkdirSync(exportCwd, { recursive: true });

    const result = await researchTool.execute(
        { query: 'test', depth: 0 }, 
        { apiKey: 'test', provider: 'mock', model: 'mock-model', reportExportEnabled: true }, 
        { cwd: exportCwd } as any
    );

    expect(result).toContain('integrated research report');
    expect(result).toContain('Research report saved to');
  });

  it('should handle health check', async () => {
    const healthTool = plugin.tools.find(t => t.name === 'health')!;
    const result = await healthTool.execute({} as any, {} as any, {});
    expect(result).toContain('Status');
  });
});
