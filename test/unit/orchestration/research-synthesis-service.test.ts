import { describe, it, expect, beforeEach } from 'vitest';
import { ResearchSynthesisService } from '../../../src/orchestration/research-synthesis-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';

// Suppress logger output during tests
import { vi } from 'vitest';
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Helper: build a report string with a CITED LINKS section parseable by parseCitations
function reportWithCitations(urls: { url: string; desc?: string }[]): string {
  const lines = urls.map((u, i) => `[${i + 1}] ${u.url}${u.desc ? ` - ${u.desc}` : ''}`).join('\n');
  return `Some report content.\n\nCITED LINKS\n${lines}`;
}

describe('ResearchSynthesisService', () => {
  let service: ResearchSynthesisService;

  beforeEach(() => {
    service = new ResearchSynthesisService();
  });

  // ─── storeReport / getReport ────────────────────────────────────────────────

  describe('storeReport / getReport', () => {
    it('stores a report and retrieves it by ID', () => {
      service.storeReport('test-session', '1.A', 'Report A content');
      expect(service.getReport('test-session', '1.A')).toBe('Report A content');
    });

    it('returns undefined for a report ID that does not exist', () => {
      expect(service.getReport('test-session', '99.Z')).toBeUndefined();
    });

    it('overwrites an existing report when the same ID is stored again', () => {
      service.storeReport('test-session', '1.A', 'original');
      service.storeReport('test-session', '1.A', 'replacement');
      expect(service.getReport('test-session', '1.A')).toBe('replacement');
    });
  });

  // ─── getAllReports ───────────────────────────────────────────────────────────

  describe('getAllReports', () => {
    it('returns a copy of the internal map; mutating it does not affect the service', () => {
      service.storeReport('test-session', '1.A', 'report A');
      const copy = service.getAllReports('test-session');
      copy.set('1.A', 'mutated');
      copy.set('2.B', 'injected');
      // Original is unaffected
      expect(service.getReport('test-session', '1.A')).toBe('report A');
      expect(service.getReport('test-session', '2.B')).toBeUndefined();
    });
  });

  // ─── getReportsForRound ──────────────────────────────────────────────────────

  describe('getReportsForRound', () => {
    it('returns only the reports for the requested round', () => {
      service.storeReport('test-session', '1.A', 'r1a');
      service.storeReport('test-session', '1.B', 'r1b');
      service.storeReport('test-session', '2.A', 'r2a');

      const round1 = service.getReportsForRound('test-session', 1);
      expect(round1.size).toBe(2);
      expect(round1.get('1.A')).toBe('r1a');
      expect(round1.get('1.B')).toBe('r1b');
      expect(round1.has('2.A')).toBe(false);
    });

    it('returns an empty map when no reports exist for the round', () => {
      service.storeReport('test-session', '2.A', 'r2a');
      expect(service.getReportsForRound('test-session', 5).size).toBe(0);
    });

    it('does not include a key starting with "10" in round 1 results (prefix-match safeguard)', () => {
      service.storeReport('test-session', '1.A', 'round-one');
      service.storeReport('test-session', '10.A', 'round-ten');

      const round1 = service.getReportsForRound('test-session', 1);
      expect(round1.has('1.A')).toBe(true);
      expect(round1.has('10.A')).toBe(false);
    });
  });

  // ─── getReportCount / hasReports ────────────────────────────────────────────

  describe('getReportCount / hasReports', () => {
    it('returns count 0 and hasReports false on a fresh instance', () => {
      expect(service.getReportCount('test-session')).toBe(0);
      expect(service.hasReports('test-session')).toBe(false);
    });

    it('returns count 1 and hasReports true after storing one report', () => {
      service.storeReport('test-session', '1.A', 'content');
      expect(service.getReportCount('test-session')).toBe(1);
      expect(service.hasReports('test-session')).toBe(true);
    });
  });

  // ─── clearReports ───────────────────────────────────────────────────────────

  describe('clearReports', () => {
    it('removes all stored reports; count returns to 0', () => {
      service.storeReport('test-session', '1.A', 'a');
      service.storeReport('test-session', '1.B', 'b');
      service.clearReports();
      expect(service.getReportCount('test-session')).toBe(0);
      expect(service.hasReports('test-session')).toBe(false);
    });
  });

  // ─── buildFallbackSynthesis ──────────────────────────────────────────────────

  describe('buildFallbackSynthesis', () => {
    it('contains the "no reports" message when there are no reports', () => {
      const synthesis = service.buildFallbackSynthesis('test-session');
      expect(synthesis).toContain('No researcher reports were generated');
    });

    it('contains both researcher IDs and report contents when there are 2 reports', () => {
      service.storeReport('test-session', '1.A', 'Alpha report content');
      service.storeReport('test-session', '1.B', 'Beta report content');
      const synthesis = service.buildFallbackSynthesis('test-session');
      expect(synthesis).toContain('1.A');
      expect(synthesis).toContain('Alpha report content');
      expect(synthesis).toContain('1.B');
      expect(synthesis).toContain('Beta report content');
      expect(synthesis).toContain('automated synthesis');
    });

    it('contains "Round 2" when currentRound is 2', () => {
      const synthesis = service.buildFallbackSynthesis('test-session', 2);
      expect(synthesis).toContain('Round 2');
    });

    it('does NOT contain "Round 0" when currentRound defaults to 0', () => {
      const synthesis = service.buildFallbackSynthesis('test-session');
      expect(synthesis).not.toContain('Round 0');
    });
  });

  // ─── ensureCitedLinks ────────────────────────────────────────────────────────

  describe('ensureCitedLinks', () => {
    it('returns the synthesis unchanged when no reports are stored (no-op early return)', () => {
      const input = 'Some findings.\n\nCITED LINKS\n[1] https://example.com - desc';
      expect(service.ensureCitedLinks('test-session', input)).toBe(input);
    });

    it('appends a CITED LINKS section built from report URLs when missing', () => {
      service.storeReport('test-session', 
        '1.A',
        reportWithCitations([
          { url: 'https://example.org/page', desc: 'example site' },
          { url: 'https://another.org/page', desc: 'other site' },
        ])
      );
      const result = service.ensureCitedLinks('test-session', 'Synthesis without links.');
      expect(result).toContain('CITED LINKS');
      expect(result).not.toContain('###');
      expect(result).toContain('https://example.org/page');
      expect(result).toContain('https://another.org/page');
    });

    it('returns the original synthesis unchanged when no parseable URLs exist in reports', () => {
      service.storeReport('test-session', '1.A', 'A report with no citation section at all.');
      const input = 'Synthesis without links.';
      expect(service.ensureCitedLinks('test-session', input)).toBe(input);
    });
  });

  // ─── appendSteeringGuidance ──────────────────────────────────────────────────

  describe('appendSteeringGuidance', () => {
    it('returns the synthesis unchanged when steeringMessages is empty', () => {
      const input = 'Final report content';
      expect(service.appendSteeringGuidance(input, [])).toBe(input);
    });

    it('returns the synthesis unchanged when steeringMessages is undefined', () => {
      const input = 'Final report content';
      expect(service.appendSteeringGuidance(input, undefined as any)).toBe(input);
    });

    it('appends a formatted steering guidance section for active messages', () => {
      const input = 'Final report content';
      const messages = [
        { id: '1', text: 'focus on modern times', status: 'active' as const, addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
        { id: '2', text: 'ignore historical data', status: 'active' as const, addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
      ];
      const result = service.appendSteeringGuidance(input, messages);

      expect(result).toContain('Final report content');
      expect(result).not.toContain('---');
      expect(result).toContain('The following guidance was provided by the user during the research process and influenced these results:');
      expect(result).toContain('focus on modern times');
      expect(result).toContain('ignore historical data');
    });

    it('appends guidance from SteeringMessage objects — only active messages', () => {
      const input = 'Final report content';
      const messages = [
        { id: '1', text: 'focus on active', status: 'active' as const, addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
        { id: '2', text: 'still queued', status: 'queued' as const, addedAt: Date.now(), consumedAt: null, poppedAt: null },
      ];
      const result = service.appendSteeringGuidance(input, messages);
      
      expect(result).toContain('Final report content');
      expect(result).toContain('The following guidance was provided by the user during the research process and influenced these results:');
      expect(result).toContain('focus on active');
      // Queued messages should NOT be in the report
      expect(result).not.toContain('still queued');
    });

    it('excludes popped messages from SteeringMessage objects', () => {
      const input = 'Final report content';
      const messages = [
        { id: '1', text: 'popped message', status: 'popped' as const, addedAt: Date.now(), consumedAt: null, poppedAt: Date.now() },
      ];
      const result = service.appendSteeringGuidance(input, messages);
      
      // Only popped = no guidance section
      expect(result).toBe(input);
    });

    it('trims the synthesis before appending', () => {
      const input = '  Final report content  ';
      const messages = [
        { id: '1', text: 'steer', status: 'active' as const, addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
      ];
      const result = service.appendSteeringGuidance(input, messages);
      expect(result.startsWith('Final report content')).toBe(true);
    });
  });

  // ─── extractAllCitations ─────────────────────────────────────────────────────

  describe('extractAllCitations', () => {
    it('returns deduplicated citations across multiple reports', () => {
      service.storeReport('test-session', 
        '1.A',
        reportWithCitations([
          { url: 'https://shared.example.org/page', desc: 'shared' },
          { url: 'https://only-a.example.org/page', desc: 'only in A' },
        ])
      );
      service.storeReport('test-session', 
        '1.B',
        reportWithCitations([
          { url: 'https://shared.example.org/page', desc: 'shared again' },
          { url: 'https://only-b.example.org/page', desc: 'only in B' },
        ])
      );

      const citations = service.extractAllCitations('test-session');
      const urls = citations.map((c) => c.url);

      expect(urls.filter((u) => u === 'https://shared.example.org/page').length).toBe(1);
      expect(urls).toContain('https://only-a.example.org/page');
      expect(urls).toContain('https://only-b.example.org/page');
      expect(citations.length).toBe(3);
    });
  });

  // ─── extractCitationsForRound ─────────────────────────────────────────────────

  describe('extractCitationsForRound', () => {
    it('only extracts citations from reports matching the specified round prefix', () => {
      service.storeReport('test-session', 
        '1.A',
        reportWithCitations([{ url: 'https://first-round.example.com/page', desc: 'round one result' }])
      );
      service.storeReport('test-session', 
        '2.A',
        reportWithCitations([{ url: 'https://second-round.example.com/page', desc: 'round two result' }])
      );

      const round1Citations = service.extractCitationsForRound('test-session', 1);
      const urls = round1Citations.map((c) => c.url);

      expect(urls).toContain('https://first-round.example.com/page');
      expect(urls).not.toContain('https://second-round.example.com/page');
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('starts with UNINITIALIZED lifecycle', () => {
      expect(service.lifecycle).toBe(ServiceLifecycle.UNINITIALIZED);
    });

    it('transitions to INITIALIZED after initialize()', async () => {
      await service.initialize();
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('initialize() is idempotent — calling it twice stays INITIALIZED', async () => {
      await service.initialize();
      await service.initialize();
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('transitions to DISPOSED after dispose(), and stored reports are cleared', async () => {
      service.storeReport('test-session', '1.A', 'some content');
      await service.initialize();
      await service.dispose();
      expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
      expect(service.hasReports('test-session')).toBe(false);
    });
  });
});
