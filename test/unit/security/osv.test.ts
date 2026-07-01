import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchOSV } from '../../../src/security/osv-client.ts';

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

    it('derives severity + CVSS score from a v3 vector when no database_specific.severity (non-GHSA)', async () => {
      // A CVE-sourced OSV record: severity lives only in a CVSS vector, not database_specific.
      const mockVuln = {
        id: 'CVE-2023-9999',
        summary: 'Test CVE with CVSS vector only',
        modified: '2023-01-01T00:00:00Z',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      };
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => mockVuln } as Response);

      const result = await searchOSV(['CVE-2023-9999']);

      expect(result.vulnerabilities[0]!.severity).toBe('CRITICAL'); // was UNKNOWN before the calculator
      expect(result.vulnerabilities[0]!.cvssScore).toBe(9.8);
      expect(result.vulnerabilities[0]!.cvssVector).toContain('CVSS:3.1');
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
      // Per-term failures are aggregated with the offending term for context; a
      // thrown non-Error string is still coerced and surfaced.
      expect(result.error).toContain('string error');
      expect(result.vulnerabilities).toHaveLength(0);
    });
  });

});
