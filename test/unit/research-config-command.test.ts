/**
 * /research-config command — host-mode gating tests
 *
 * Pins the cross-host behavior of handleResearchConfigCommand:
 * - non-TUI hosts (rpc/print/json/sdk) get a clear non-interactive guidance
 *   message instead of silently opening (or appearing to open) a menu that
 *   cannot render — in RPC ctx.hasUI is TRUE, so a hasUI-only gate is not
 *   enough; the menu must be gated on ctx.mode === 'tui'.
 * - `/research-config health` and `knowledge-status` run headlessly on ANY
 *   host (the tool text points users at health for diagnostics).
 * - the interactive menu still opens in a real TUI.
 * - every destructive confirm carries a timeout, so no host can wedge on one.
 *
 * Modules are imported and mocked through the repo's `@/` alias (vitest
 * resolve.alias); with this config, alias-form imports resolve to different
 * module instances than relative-path imports, so mocks must use the same
 * alias form the graph uses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAll: vi.fn(),
  initGlobalTuiController: vi.fn(),
  setInteractiveTuiActive: vi.fn(),
  normalizeSessionId: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  resetConfig: vi.fn(),
  getDbDir: vi.fn(),
  getGlobalEnvFilePath: vi.fn(),
  probeAvailability: vi.fn(),
  skillInstallCandidates: vi.fn(),
  skillUninstallCandidates: vi.fn(),
  getRunHistory: vi.fn(),
  getSessionStartedAt: vi.fn(),
  clearSession: vi.fn(),
  getService: vi.fn(),
  clearService: vi.fn(),
  tryGetServiceContainerFromCtx: vi.fn(),
  aggregateSessionStats: vi.fn(),
  buildSessionOverview: vi.fn(),
  extractRunStats: vi.fn(),
}));

vi.mock('@/healthcheck/index.ts', () => ({
  healthRegistry: { runAll: mocks.runAll },
}));
vi.mock('@/tui/tui-controller.ts', () => ({
  initGlobalTuiController: mocks.initGlobalTuiController,
  setInteractiveTuiActive: mocks.setInteractiveTuiActive,
}));
vi.mock('@/orchestration/session-state.ts', () => ({
  normalizeSessionId: mocks.normalizeSessionId,
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
  describeKnowledgeStoreUnavailability: vi.fn(() => ''),
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
  metrics: {
    getRunHistory: mocks.getRunHistory,
    getSessionStartedAt: mocks.getSessionStartedAt,
    clearSession: mocks.clearSession,
  },
}));
vi.mock('@/utils/metrics-summary.ts', () => ({
  aggregateSessionStats: mocks.aggregateSessionStats,
  buildSessionOverview: mocks.buildSessionOverview,
  extractRunStats: mocks.extractRunStats,
}));
vi.mock('@/core/service-registry.ts', () => ({
  getService: mocks.getService,
  clearService: mocks.clearService,
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
  KNOWLEDGE_STORE_CACHE_TTL_DAYS: 30,
  EMBEDDING_MODEL: 'model-1',
  EMBEDDING_DEVICE: 'auto',
  MAX_SCRAPE_BATCHES: 3,
  MAX_CONCURRENT_RESEARCHERS: 3,
  RESEARCHER_TIMEOUT_MS: 30000,
  RESEARCH_REPORT_EXPORT_ENABLED: false,
  DEBUG: false,
};

describe('handleResearchConfigCommand host-mode gating', () => {
  let ui: any;
  let pi: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeSessionId.mockReturnValue('default');
    mocks.getConfig.mockReturnValue({ ...BASE_CONFIG });
    mocks.probeAvailability.mockReturnValue({ available: true, missing: [] });
    mocks.skillInstallCandidates.mockReturnValue([]);
    mocks.skillUninstallCandidates.mockReturnValue([]);
    mocks.getRunHistory.mockReturnValue([]);
    mocks.getSessionStartedAt.mockReturnValue(new Date().toISOString());
    mocks.getService.mockResolvedValue({});
    mocks.tryGetServiceContainerFromCtx.mockReturnValue({ isReady: true });
    mocks.aggregateSessionStats.mockReturnValue({});
    mocks.buildSessionOverview.mockReturnValue('');
    mocks.extractRunStats.mockReturnValue({});
    mocks.runAll.mockResolvedValue({ status: 'healthy', components: [], checkTime: new Date().toISOString() });
    ui = {
      hasUI: true,
      custom: vi.fn(async () => ({ type: 'cancel' })),
      confirm: vi.fn(async () => false),
      notify: vi.fn(),
    };
    pi = { sendMessage: vi.fn() };
  });

  function ctx(mode: string, hasUI = true) {
    return { mode, hasUI, cwd: '/tmp', sessionId: 's1', ui } as any;
  }

  it('RPC host (hasUI true, mode rpc): no args → guidance message, menu never opens', async () => {
    await handleResearchConfigCommand('', ctx('rpc'), pi);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const sent = pi.sendMessage.mock.calls[0]![0]!;
    expect(sent.customType).toBe('research-config');
    expect(sent.display).toBe(true);
    expect(sent.content).toContain('/research-config health');
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it('print host (hasUI false): same clear guidance, no UI calls', async () => {
    await handleResearchConfigCommand('', ctx('print', false), pi);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it('RPC host: `/research-config health` runs the health check headlessly', async () => {
    await handleResearchConfigCommand('health', ctx('rpc'), pi);

    expect(mocks.runAll).toHaveBeenCalledWith({ force: true });
    expect(ui.custom).not.toHaveBeenCalled();
    // The health report is delivered through pi.sendMessage, not a UI dialog.
    expect(pi.sendMessage).toHaveBeenCalled();
  });

  it('TUI host: `/research-config health` short-circuits to the headless check (no menu)', async () => {
    await handleResearchConfigCommand('health', ctx('tui'), pi);

    expect(mocks.runAll).toHaveBeenCalledWith({ force: true });
    expect(ui.custom).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalled();
  });

  it('TUI host: no args opens the interactive menu; cancel resolves quietly', async () => {
    await handleResearchConfigCommand('', ctx('tui'), pi);

    expect(mocks.initGlobalTuiController).toHaveBeenCalled();
    expect(ui.custom).toHaveBeenCalledTimes(1);
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(mocks.setInteractiveTuiActive).toHaveBeenLastCalledWith(false);
  });

  it('TUI host: unknown verb opens the menu (only known verbs short-circuit)', async () => {
    await handleResearchConfigCommand('something-else', ctx('tui'), pi);

    expect(ui.custom).toHaveBeenCalledTimes(1);
  });

  it('menu action "metrics" reaches confirm with a timeout (never wedges any host)', async () => {
    ui.custom = vi.fn(async () => ({ type: 'action', action: 'metrics' }));
    await handleResearchConfigCommand('', ctx('tui'), pi);

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    const [title, , opts] = ui.confirm.mock.calls[0]!;
    expect(title).toBe('Session Metrics');
    expect(opts?.timeout).toBe(60_000);
    // Declined → nothing was cleared.
    expect(mocks.clearSession).not.toHaveBeenCalled();
    expect(mocks.setInteractiveTuiActive).toHaveBeenLastCalledWith(false);
  });
});