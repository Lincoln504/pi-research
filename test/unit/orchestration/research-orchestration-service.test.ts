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
  healthRegistry: { runAll: vi.fn() },
}));

// Mock other imports that are not under test
vi.mock('../../../src/utils/text-utils.ts', () => ({
  parseCitations: vi.fn(() => []),
}));

vi.mock('../../../src/utils/shared-links.ts', () => ({
  getCachedScrapedContent: vi.fn(() => null),
  normalizeUrl: vi.fn((url: string) => url),
}));

vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return {
    ...actual,
    getService: vi.fn(),
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

    it('two researchers with overlapping URLs — each gets only their own query URLs', async () => {
      const plan = {
        researchers: [
          { id: 'r1', queries: ['q1'] },
          { id: 'r2', queries: ['q2'] },
        ],
      };
      const results = [
        { query: 'q1', results: [{ url: 'https://shared.com' }, { url: 'https://only-r1.com' }] },
        { query: 'q2', results: [{ url: 'https://shared.com' }, { url: 'https://only-r2.com' }] },
      ];

      const map = await service.distributeSearchResults(plan as any, results as any);

      // r1 gets only q1 results
      expect(map.get('r1')).toEqual(expect.arrayContaining(['https://shared.com', 'https://only-r1.com']));
      expect(map.get('r1')).not.toContain('https://only-r2.com');
      // r2 gets only q2 results
      expect(map.get('r2')).toEqual(expect.arrayContaining(['https://shared.com', 'https://only-r2.com']));
      expect(map.get('r2')).not.toContain('https://only-r1.com');
    });

    it('URL deduplication: same URL from two queries for one researcher appears once', async () => {
      const plan = {
        researchers: [
          { id: 'r1', queries: ['q1', 'q2'] },
        ],
      };
      const results = [
        { query: 'q1', results: [{ url: 'https://dup.com' }, { url: 'https://unique.com' }] },
        { query: 'q2', results: [{ url: 'https://dup.com' }] },
      ];

      const map = await service.distributeSearchResults(plan as any, results as any);

      const urls = map.get('r1')!;
      expect(urls.filter(u => u === 'https://dup.com')).toHaveLength(1);
      expect(urls).toHaveLength(2);
    });

    it('researcher with no queries gets empty array', async () => {
      const plan = {
        researchers: [
          { id: 'r1', queries: [] },
        ],
      };
      const results = [
        { query: 'q1', results: [{ url: 'https://a.com' }] },
      ];

      const map = await service.distributeSearchResults(plan as any, results as any);

      expect(map.get('r1')).toEqual([]);
    });

    it('empty results array returns empty arrays for all researchers', async () => {
      const plan = {
        researchers: [
          { id: 'r1', queries: ['q1'] },
          { id: 'r2', queries: ['q2'] },
        ],
      };

      const map = await service.distributeSearchResults(plan as any, []);

      expect(map.get('r1')).toEqual([]);
      expect(map.get('r2')).toEqual([]);
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
      expect(mockSearch).toHaveBeenCalledWith(['foo', 'bar'], {}, undefined, undefined);
    });

    it('passes signal and onProgress callback through to search', async () => {
      mockSearch.mockResolvedValue([]);
      const signal = new AbortController().signal;
      const onProgress = vi.fn();

      await service.runSearchBurst(['q'], { some: 'config' } as any, signal, onProgress);

      expect(mockSearch).toHaveBeenCalledWith(['q'], { some: 'config' } as any, signal, onProgress);
    });
  });

  // =========================================================================
  // checkHealth
  // =========================================================================

  describe('checkHealth', () => {
    it('round 1: returns true without calling healthRegistry.runAll()', async () => {
      const result = await service.checkHealth(1);

      expect(result).toBe(true);
      expect(mockRunAll).not.toHaveBeenCalled();
    });

    it('round 0: returns true without calling healthRegistry.runAll()', async () => {
      const result = await service.checkHealth(0);

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

    beforeEach(() => {
      vi.mocked(getService).mockImplementation(async (name) => {
        if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService as any;
        if (name === ServiceNames.WRITER_QUEUE) return mockWriter as any;
        return null;
      });
    });

    it('returns early if KNOWLEDGE_STORE_ENABLED is false', async () => {
      await service.storeLinkDescriptions('s1', 1, 'r1', { LOCAL_KNOWLEDGE_STORE_ENABLED: false, GLOBAL_KNOWLEDGE_STORE_ENABLED: false } as any);
      expect(mockSynthesisService.getAllReports).not.toHaveBeenCalled();
    });

    it('enqueues citations from reports matching the round prefix', async () => {
      const config = { LOCAL_KNOWLEDGE_STORE_ENABLED: true };
      const reportContent = '### CITED LINKS\n[1] https://foo.com\nSource: X\nDescription: D';
      const reports = new Map([
        ['1.res1', reportContent],
        ['2.res2', 'other round'],
      ]);
      
      mockSynthesisService.getAllReports.mockReturnValue(reports);
      vi.mocked(parseCitations).mockReturnValue([{ url: 'https://foo.com', description: 'D', source: 'X' }]);

      await service.storeLinkDescriptions('s1', 1, 'r1', config as any);

      expect(mockWriter.enqueue).toHaveBeenCalledOnce();
      expect(mockWriter.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://foo.com',
        markdown: 'D',
        metadata: expect.objectContaining({
          researcherId: '1.res1',
          round: 1,
        }),
      }));
      expect(mockWriter.drain).toHaveBeenCalledOnce();
    });

    it('skips reports with no parseable citations', async () => {
      const config = { LOCAL_KNOWLEDGE_STORE_ENABLED: true };
      const reports = new Map([['1.res1', 'no citations']]);
      
      mockSynthesisService.getAllReports.mockReturnValue(reports);
      vi.mocked(parseCitations).mockReturnValue([]);

      await service.storeLinkDescriptions('s1', 1, 'r1', config as any);

      expect(mockWriter.enqueue).not.toHaveBeenCalled();
      expect(mockWriter.drain).not.toHaveBeenCalled();
    });

    it('handles synthesis service with no reports', async () => {
        const config = { LOCAL_KNOWLEDGE_STORE_ENABLED: true };
        mockSynthesisService.getAllReports.mockReturnValue(new Map());

        await service.storeLinkDescriptions('s1', 1, 'r1', config as any);

        expect(mockWriter.enqueue).not.toHaveBeenCalled();
      });
  });

  // =========================================================================
  // runResearchers
  // =========================================================================

  describe('runResearchers', () => {
    it('runResearchers passes storeLinks to each researcher as historicalUrls', async () => {
      const { runResearcher } = await import('../../../src/orchestration/researcher-executor.ts');
      const mockRunResearcher = vi.mocked(runResearcher);
      mockRunResearcher.mockResolvedValue(undefined);

      vi.mocked(getService).mockResolvedValue({
        name: 'planning',
        lifecycle: 'initialized',
        initialize: vi.fn(),
        dispose: vi.fn(),
        getCurrentPlan: vi.fn().mockReturnValue(null),
      } as any);

      const plan = {
        researchers: [{ id: 'r1', name: 'R1', goal: 'g', queries: ['q'] }],
      };
      const storeLinks = new Map([
        ['r1', [{ url: 'https://store.com', description: 'Store description' }]],
      ]);

      await service.runResearchers({
        plan: plan as any,
        options: {
          sessionId: 's1', researchId: 'r1',
          config: { RESEARCHER_MAX_RETRIES: 0, RESEARCHER_MAX_RETRY_DELAY_MS: 0, RESEARCHER_TIMEOUT_MS: 5000 },
          ctx: {},
          model: {},
        } as any,
        currentRound: 1,
      }, undefined, storeLinks);

      expect(mockRunResearcher).toHaveBeenCalledOnce();
      const callArgs = mockRunResearcher.mock.calls[0][0];
      expect(callArgs.historicalUrls).toEqual([{ url: 'https://store.com', description: 'Store description' }]);
    });
  });
});
