import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchOSV, getOSVById } from '../../../src/security/osv.ts';

describe('OSV Client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('searchOSV', () => {
    it('should search for a CVE ID', async () => {
      const mockVuln = {
        id: 'CVE-2023-0001',
        summary: 'Test CVE',
        modified: '2023-01-01T00:00:00Z'
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockVuln,
      } as Response);

      const result = await searchOSV(['CVE-2023-0001']);

      expect(result.count).toBe(1);
      expect(result.vulnerabilities[0]!.id).toBe('CVE-2023-0001');
    });

    it('should normalize GHSA IDs', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'GHSA-xxxx-yyyy-zzzz' }),
      } as Response);

      await searchOSV(['GHSA-XXXX-YYYY-ZZZZ']);

      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/vulns/GHSA-xxxx-yyyy-zzzz'),
        expect.anything()
      );
    });

    it('should search for packages with ecosystem', async () => {
      const mockResponse = {
        vulns: [{ id: 'OSV-1', summary: 'Package vuln' }]
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await searchOSV(['test-pkg'], { ecosystem: 'npm' });

      expect(result.count).toBe(1);
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/query'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ package: { name: 'test-pkg', ecosystem: 'npm' } })
        })
      );
    });

    it('should skip package search if ecosystem is missing', async () => {
      const result = await searchOSV(['test-pkg']);

      expect(result.count).toBe(0);
      expect(result.error).toContain('require the ecosystem parameter');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500
      } as Response);

      const result = await searchOSV(['CVE-FAIL']);

      expect(result.count).toBe(0);
      expect(fetch).toHaveBeenCalled();
    });

    it('should handle unexpected data format in search', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unexpected: 'format' }),
      } as Response);

      const result = await searchOSV(['CVE-123']);
      expect(result.count).toBe(0);
    });

    it('should filter by severity', async () => {
      const mockResponse = {
        vulns: [
          {
            id: 'OSV-HIGH',
            database_specific: { severity: 'HIGH' }
          },
          {
            id: 'OSV-LOW',
            database_specific: { severity: 'LOW' }
          }
        ]
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await searchOSV(['pkg'], { ecosystem: 'npm', severity: 'HIGH' });

      expect(result.count).toBe(1);
      expect(result.vulnerabilities[0]!.id).toBe('OSV-HIGH');
    });

    it('should parse complex OSV fields (ranges, CWEs, references)', async () => {
      const mockVuln = {
        id: 'OSV-COMPLEX',
        details: 'Full details',
        database_specific: {
          severity: 'MODERATE',
          cwe: [{ id: 'CWE-123' }, 'CWE-456']
        },
        affected: [{
          package: { name: 'pkg-a' },
          ranges: [{
            type: 'SEMVER',
            events: [{ introduced: '1.0.0' }, { fixed: '1.1.0' }, { last_affected: '1.0.9' }]
          }]
        }],
        references: [{ type: 'WEB', url: 'https://example.com' }],
        aliases: ['CVE-2023-X']
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockVuln,
      } as Response);

      const result = await searchOSV(['OSV-COMPLEX']);
      const vuln = result.vulnerabilities[0]!;

      expect(vuln.severity).toBe('MEDIUM');
      expect(vuln.cwes).toContain('CWE-123');
      expect(vuln.cwes).toContain('CWE-456');
      expect(vuln.fixes[0]!).toContain('last affected: 1.0.9');
    });

    it('should handle unknown severity and empty fields', async () => {
      const mockVuln = {
        id: 'OSV-EMPTY',
        database_specific: { severity: 'UNKNOWN_VAL' }
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockVuln,
      } as Response);

      const result = await searchOSV(['OSV-EMPTY']);
      expect(result.vulnerabilities[0]!.severity).toBe('UNKNOWN');
    });

    it('should handle non-Error exceptions in searchOSV', async () => {
      vi.mocked(fetch).mockImplementationOnce(() => { throw 'string error'; });
      const result = await searchOSV(['CVE-123']);
      expect(result.error).toBe('string error');
    });
  });

  describe('getOSVById', () => {
    it('should fetch a single OSV by ID', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'OSV-123' }),
      } as Response);

      const result = await getOSVById('OSV-123');
      expect(result?.id).toBe('OSV-123');
    });

    it('should handle errors in getOSVById', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Fetch failed'));
      const result = await getOSVById('OSV-FAIL');
      expect(result).toBeNull();
    });

    it('should handle unexpected format in getOSVById', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unexpected: 'data' }), // missing id
      } as Response);
      const result = await getOSVById('OSV-123');
      expect(result).toBeNull();
    });
  });
});
