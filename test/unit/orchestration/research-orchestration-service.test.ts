import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResearchOrchestrationService } from '../../../src/orchestration/research-orchestration-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';

// Mock logger
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock constants
vi.mock('../../../src/constants.ts', () => ({
  RESEARCHER_LAUNCH_DELAY_MS: 0,
}));

// Mock search
vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn(),
}));

// Mock healthRegistry
vi.mock('../../../src/healthcheck/index.ts', () => ({
  healthRegistry: { runAll: vi.fn(), isCritical: vi.fn(() => true) },
}));

// Mock other imports that are not under test
vi.mock('../../../src/utils/text-utils.ts', () => ({
  parseCitations: vi.fn(() => []),
}));

vi.mock('../../../src/utils/shared-links.ts', () => ({
  getCachedScrapedContent: vi.fn(() => null),
  normalizeUrl: vi.fn((url: string) => url),
  cleanupSharedLinks: vi.fn(),
}));

vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return {
    ...actual,
    getService: vi.fn(),
    tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
  };
});

vi.mock('../../../src/orchestration/researcher-executor.ts', () => ({
  runResearcher: vi.fn(),
}));

vi.mock('../../../src/utils/session-state.ts', () => ({
  recordResearcherFailure: vi.fn(),
  shouldStopResearch: vi.fn(() => false),
  getResearchStopMessage: vi.fn(() => 'Research stopped: 0 researcher(s) failed: '),
}));

// ---------------------------------------------------------------------------

import { search } from '../../../src/web-research/search.ts';
import { healthRegistry } from '../../../src/healthcheck/index.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { parseCitations } from '../../../src/utils/text-utils.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

const mockSearch = search as ReturnType<typeof vi.fn>;
const mockRunAll = healthRegistry.runAll as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------

describe('ResearchOrchestrationService', () => {
  let service: ResearchOrchestrationService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new ResearchOrchestrationService();
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('starts UNINITIALIZED', () => {
      expect(service.lifecycle).toBe(ServiceLifecycle.UNINITIALIZED);
    });

    it('is INITIALIZED after initialize()', async () => {
      await service.initialize();
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('is DISPOSED after dispose()', async () => {
      await service.initialize();
      await service.dispose();
      expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
    });
  });

  // =========================================================================
  // distributeSearchResults
  // =========================================================================

  describe('distributeSearchResults', () => {
    it('single researcher with 2 queries, each returning 2 results — gets 4 unique URLs', async () => {
      const plan = {
        researchers: [
          { id: 'r1', queries: ['q1', 'q2'] },
        ],
      };
      const results = [
        { query: 'q1', results: [{ url: 'https://a.com' }, { url: 'https://b.com' }] },
        { query: 'q2', results: [{ url: 'https://c.com' }, { url: 'https://d.com' }] },
      ];

      const map = await service.distributeSearchResults(plan as any, results as any);

      expect(map.get('r1')).toHaveLength(4);
      expect(map.get('r1')).toEqual(
        expect.arrayContaining(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'])
      );
    });
  });

  // =========================================================================
  // runSearchBurst
  // =========================================================================

  describe('runSearchBurst', () => {
    it('returns results from mocked search and logs total count', async () => {
      const fakeResults = [
        { query: 'foo', results: [{ url: 'https://x.com' }, { url: 'https://y.com' }] },
        { query: 'bar', results: [{ url: 'https://z.com' }] },
      ];
      mockSearch.mockResolvedValue(fakeResults);

      const out = await service.runSearchBurst(['foo', 'bar'], {} as any);

      expect(out).toBe(fakeResults);
      expect(mockSearch).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // checkHealth
  // =========================================================================

  describe('checkHealth', () => {
    beforeEach(() => {
        vi.mocked(getService).mockImplementation(async (name) => {
            if (name === ServiceNames.HEALTH_REGISTRY) return healthRegistry as any;
            return null;
        });
    });

    it('round 1: returns true without calling healthRegistry.runAll()', async () => {
      const result = await service.checkHealth(1);

      expect(result).toBe(true);
      expect(mockRunAll).not.toHaveBeenCalled();
    });

    it('round 2 with healthy status: returns true', async () => {
      mockRunAll.mockResolvedValue({ status: 'healthy', components: [] });

      const result = await service.checkHealth(2, 'res-123');

      expect(result).toBe(true);
      expect(mockRunAll).toHaveBeenCalledOnce();
    });

    it('round 2 with degraded status: returns true (research continues)', async () => {
      mockRunAll.mockResolvedValue({
        status: 'degraded',
        components: [{ component: 'search', healthy: false }],
      });

      const result = await service.checkHealth(2, 'res-123');

      expect(result).toBe(true);
    });

    it('round 2 with unhealthy status: returns false', async () => {
      mockRunAll.mockResolvedValue({
        status: 'unhealthy',
        components: [{ component: 'db', healthy: false }, { component: 'search', healthy: false }],
      });

      const result = await service.checkHealth(2, 'res-123');

      expect(result).toBe(false);
    });

    it('healthRegistry.runAll() throws: returns true (non-fatal)', async () => {
      mockRunAll.mockRejectedValue(new Error('registry exploded'));

      const result = await service.checkHealth(3);

      expect(result).toBe(true);
    });
  });

  // =========================================================================
  // storeLinkDescriptions
  // =========================================================================

  describe('storeLinkDescriptions', () => {
    const mockSynthesisService = {
      getAllReports: vi.fn(),
    };

    const mockWriter = {
      enqueue: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
    };

    const mockKnowledgeStoreService = {
        isReady: vi.fn().mockReturnValue(true),
        getStore: vi.fn().mockResolvedValue({
            rebuildFtsIndex: vi.fn().mockResolvedValue(undefined),
        }),
    };

    beforeEach(() => {
      vi.mocked(getService).mockImplementation(async (name) => {
        if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService as any;
        if (name === ServiceNames.WRITER_QUEUE) return mockWriter as any;
        if (name === ServiceNames.KNOWLEDGE_STORE) return mockKnowledgeStoreService as any;
        return null;
      });
    });

    it('returns early if knowledge store is not ready', async () => {
      const mockNotReadyKS = { ...mockKnowledgeStoreService, isReady: vi.fn().mockReturnValue(false) };
      vi.mocked(getService).mockImplementation(async (name) => {
        if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService as any;
        if (name === ServiceNames.KNOWLEDGE_STORE) return mockNotReadyKS as any;
        return null;
      });

      await service.storeLinkDescriptions('s1', 1, 'r1', {} as any);
      expect(mockSynthesisService.getAllReports).not.toHaveBeenCalled();
    });

    it('enqueues citations from reports matching the round prefix', async () => {
      const localMockWriter = {
        enqueue: vi.fn(),
        drain: vi.fn().mockResolvedValue(undefined),
      };
      const localMockKS = {
        isReady: () => true,
        getStore: vi.fn().mockResolvedValue({
          rebuildFtsIndex: vi.fn().mockResolvedValue(undefined),
        }),
      };
      
      vi.mocked(getService).mockImplementation(async (name: any) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) return localMockKS as any;
        if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService as any;
        if (name === ServiceNames.WRITER_QUEUE) return localMockWriter as any;
        return null;
      });

      const config = { LOCAL_KNOWLEDGE_STORE_ENABLED: true };
      const reportContent = '### CITED LINKS\n[1] https://foo.com\nSource: X\nDescription: D';
      const reports = new Map([
        ['1.res1', reportContent],
        ['2.res2', 'other round'],
      ]);
      
      mockSynthesisService.getAllReports.mockReturnValue(reports);
      vi.mocked(parseCitations).mockReturnValue([{ url: 'https://foo.com', description: 'D', source: 'X' }]);

      await service.storeLinkDescriptions('s1', 1, 'r1', config as any);

      expect(localMockWriter.enqueue).toHaveBeenCalled();
    });
  });
});
