import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for the Knowledge Retrieval setting in the /research-config
 * TUI menu (KNOWLEDGE_STORE_RETRIEVAL).
 *
 * These assert the SETTING ITSELF is wired end-to-end:
 *   1. the item is present in the menu items when the store is enabled (and
 *      absent when the store is disabled) — this exact wiring silently went
 *      missing once, so it is pinned here;
 *   2. cycling it persists per-directory under the canonical env key;
 *   3. the embedding Model/Device items disappear in bm25 mode (they are
 *      meaningless without an embedding model).
 *
 * Unlike research-config-command.test.ts (host-mode gating), the ui.custom
 * mock HERE actually invokes the component factory, so the real
 * initialItems array and the real onChange handler are exercised.
 */

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  resetConfig: vi.fn(),
  getDbDir: vi.fn(),
  getGlobalEnvFilePath: vi.fn(),
  probeAvailability: vi.fn(),
  skillInstallCandidates: vi.fn(),
  skillUninstallCandidates: vi.fn(),
  getService: vi.fn(),
  tryGetServiceContainerFromCtx: vi.fn(),
}));

// Capture what research-config actually passes to SettingsList.
let captured: { items: any[]; onChange: (id: string, newValue: string) => Promise<void> } | null = null;

vi.mock('@earendil-works/pi-tui', async (importOriginal) => {
  const actual: any = await importOriginal();
  class SettingsListStub {
    items: any[];
    constructor(items: any[], _width: number, _theme: any, onChange: (id: string, newValue: string) => Promise<void>) {
      captured = { items, onChange };
      this.items = items;
    }
    render(_width: number) { return this.items.map(i => i.label); }
    handleInput(_data: string) { return false; }
    invalidate() {}
  }
  return { ...actual, SettingsList: SettingsListStub };
});

vi.mock('@/healthcheck/index.ts', () => ({
  healthRegistry: { runAll: vi.fn() },
}));
vi.mock('@/tui/tui-controller.ts', () => ({
  initGlobalTuiController: vi.fn(),
  setInteractiveTuiActive: vi.fn(),
}));
vi.mock('@/orchestration/session-state.ts', () => ({
  normalizeSessionId: vi.fn(() => 'default'),
}));
vi.mock('@/config.ts', () => ({
  getConfig: mocks.getConfig,
  saveConfig: mocks.saveConfig,
  resetConfig: mocks.resetConfig,
  getDbDir: mocks.getDbDir,
  getGlobalEnvFilePath: mocks.getGlobalEnvFilePath,
}));
vi.mock('@/knowledge/availability.ts', () => ({
  probeKnowledgeStoreAvailability: mocks.probeAvailability,
  describeKnowledgeStoreUnavailability: vi.fn(() => 'unavailable-reason'),
  clearAvailabilityCache: vi.fn(),
}));
vi.mock('@/skill-install/skill-installer.ts', () => ({
  HARNESSES: [],
  SKILL_AGENT_TARGETS: ['claude', 'codex', 'openclaw'],
  installSkill: vi.fn(),
  uninstallSkill: vi.fn(),
  skillInstallCandidates: mocks.skillInstallCandidates,
  skillUninstallCandidates: mocks.skillUninstallCandidates,
}));
vi.mock('@/utils/metrics.ts', () => ({
  metrics: { getRunHistory: vi.fn(() => []), getSessionStartedAt: vi.fn(() => new Date().toISOString()), clearSession: vi.fn() },
}));
vi.mock('@/utils/metrics-summary.ts', () => ({
  aggregateSessionStats: vi.fn(() => ({})),
  buildSessionOverview: vi.fn(() => ''),
  extractRunStats: vi.fn(() => ({})),
}));
vi.mock('@/core/service-registry.ts', () => ({
  getService: mocks.getService,
  clearService: vi.fn(),
  tryGetServiceContainerFromCtx: mocks.tryGetServiceContainerFromCtx,
  ServiceLifecycle: {
    UNINITIALIZED: 'UNINITIALIZED',
    INITIALIZING: 'INITIALIZING',
    INITIALIZED: 'INITIALIZED',
    DISABLED: 'DISABLED',
    DISPOSING: 'DISPOSING',
    DISPOSED: 'DISPOSED',
  },
}));
vi.mock('@/logger.ts', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleResearchConfigCommand } from '@/research-config.ts';

const BASE_CONFIG = {
  DEFAULT_RESEARCH_DEPTH: 1,
  KNOWLEDGE_STORE_MODE: 'project',
  KNOWLEDGE_STORE_RETRIEVAL: 'vector',
  KNOWLEDGE_STORE_CACHE_TTL_DAYS: 30,
  EMBEDDING_MODEL: 'model-1',
  EMBEDDING_DEVICE: 'auto',
  MAX_SCRAPE_BATCHES: 3,
  MAX_CONCURRENT_RESEARCHERS: 3,
  RESEARCHER_TIMEOUT_MS: 30000,
  RESEARCH_REPORT_EXPORT_ENABLED: false,
  DEBUG: false,
};

// Stub TUI/theme — the factory only calls theme.fg(...) and passes the TUI through.
const stubTheme = { fg: (_method: string, text: string) => text };
const stubTui = {};

function ctx(mode = 'tui') {
  return {
    mode,
    hasUI: true,
    cwd: '/tmp/proj',
    sessionId: 's1',
    ui: {
      // Unlike the gating tests, this mock RUNS the component factory so the
      // real SettingsList construction (and thus initialItems) happens.
      custom: vi.fn(async (factory: (tui: any, theme: any, kb: any, done: (v: any) => void) => any) => {
        factory(stubTui, stubTheme, undefined, () => {});
        return { type: 'cancel' };
      }),
      confirm: vi.fn(async () => false),
      notify: vi.fn(),
    },
  } as any;
}

const pi = { sendMessage: vi.fn() } as any;

function item(id: string): any {
  return captured!.items.find(i => i.id === id);
}

describe('research-config TUI — Knowledge Retrieval setting', () => {
  beforeEach(() => {
    captured = null;
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ ...BASE_CONFIG });
    mocks.probeAvailability.mockReturnValue({ available: true, missing: [] });
    mocks.skillInstallCandidates.mockReturnValue([]);
    mocks.skillUninstallCandidates.mockReturnValue([]);
    mocks.getService.mockResolvedValue({});
    mocks.tryGetServiceContainerFromCtx.mockReturnValue({ isReady: true });
  });

  it('exposes a KNOWLEDGE_STORE_RETRIEVAL item with vector|bm25 when the store is enabled', async () => {
    await handleResearchConfigCommand('', ctx(), pi);

    const retrieval = item('KNOWLEDGE_STORE_RETRIEVAL');
    expect(retrieval).toBeDefined();
    expect(retrieval.values).toEqual(['vector', 'bm25']);
    expect(retrieval.currentValue).toBe('vector');
    expect(retrieval.label).toContain('[project]');
    // The description documents the bm25 promise: no embedding model.
    expect(retrieval.description).toContain('no embedding model');
  });

  it('hides the retrieval item (and the whole store UI) when Knowledge Mode is none', async () => {
    mocks.getConfig.mockReturnValue({ ...BASE_CONFIG, KNOWLEDGE_STORE_MODE: 'none' });
    await handleResearchConfigCommand('', ctx(), pi);

    expect(item('KNOWLEDGE_STORE_RETRIEVAL')).toBeUndefined();
    expect(item('KNOWLEDGE_STORE_MODE')).toBeDefined(); // scope itself is always shown
  });

  it('hides the embedding Model/Device items in bm25 mode (no embedding model exists)', async () => {
    mocks.getConfig.mockReturnValue({ ...BASE_CONFIG, KNOWLEDGE_STORE_RETRIEVAL: 'bm25' });
    await handleResearchConfigCommand('', ctx(), pi);

    expect(item('KNOWLEDGE_STORE_RETRIEVAL')?.currentValue).toBe('bm25');
    expect(item('EMBEDDING_MODEL')).toBeUndefined();
    expect(item('EMBEDDING_DEVICE')).toBeUndefined();
    expect(item('KNOWLEDGE_STORE_CACHE_TTL_DAYS')).toBeDefined(); // still relevant
  });

  it('keeps the embedding Model/Device items in vector mode', async () => {
    await handleResearchConfigCommand('', ctx(), pi);

    expect(item('EMBEDDING_MODEL')).toBeDefined();
    expect(item('EMBEDDING_DEVICE')).toBeDefined();
  });

  it('surfaces the availability warning with the bm25 repair hint when transformers is missing', async () => {
    mocks.probeAvailability.mockReturnValue({ available: false, missing: ['@huggingface/transformers'] });
    await handleResearchConfigCommand('', ctx(), pi);

    const retrieval = item('KNOWLEDGE_STORE_RETRIEVAL');
    expect(retrieval).toBeDefined();
    expect(retrieval.description).toContain('unavailable-reason');
    expect(retrieval.description).toContain("Switching to 'bm25'");
  });

  it('persists a retrieval change per-directory under the canonical env key', async () => {
    await handleResearchConfigCommand('', ctx(), pi);

    await captured!.onChange('KNOWLEDGE_STORE_RETRIEVAL', 'bm25');

    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    const [savedConfig, scope, cwd, changedKeys] = mocks.saveConfig.mock.calls[0]!;
    expect(savedConfig.KNOWLEDGE_STORE_RETRIEVAL).toBe('bm25');
    expect(scope).toBe('local'); // project-scoped, like KNOWLEDGE_STORE_MODE
    expect(cwd).toBe('/tmp/proj');
    expect(changedKeys).toEqual(['PI_RESEARCH_KNOWLEDGE_STORE_RETRIEVAL']);
    expect(mocks.resetConfig).toHaveBeenCalled();
  });
});

