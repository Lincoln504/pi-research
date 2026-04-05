import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchGitHubAdvisories, getAdvisoryById } from '../../../src/security/github-advisories.ts';

describe('GitHub Advisories Client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('searchGitHubAdvisories', () => {
    it('should search for a CVE ID', async () => {
      const mockAdvisory = {
        ghsa_id: 'GHSA-1234',
        summary: 'Test Vulnerability',
        severity: 'high',
        published_at: '2023-01-01T00:00:00Z',
        cve_id: 'CVE-2023-1234'
      };

      vi.mocked(fetch).mockImplementation(async () => ({
        ok: true,
        json: async () => [mockAdvisory],
      } as Response));

      const result = await searchGitHubAdvisories(['CVE-2023-1234']);

      expect(result.count).toBe(1);
      expect(result.advisories[0]!.id).toBe('GHSA-1234');
      expect(result.advisories[0]!.cveId).toBe('CVE-2023-1234');
    });

    it('should search for a GHSA ID', async () => {
      const mockAdvisory = {
        ghsa_id: 'GHSA-1234',
        summary: 'Test GHSA',
        severity: 'critical'
      };

      vi.mocked(fetch).mockImplementation(async () => ({
        ok: true,
        json: async () => mockAdvisory,
      } as Response));

      const result = await searchGitHubAdvisories(['GHSA-1234']);

      expect(result.count).toBe(1);
      expect(result.advisories[0]!.id).toBe('GHSA-1234');
    });

    it('should handle list response with items property', async () => {
      const mockResponse = {
        items: [{ ghsa_id: 'GHSA-LIST', summary: 'List item' }]
      };

      vi.mocked(fetch).mockImplementation(async () => ({
        ok: true,
        json: async () => mockResponse,
      } as Response));

      const result = await searchGitHubAdvisories(['LIST']);

      expect(result.count).toBe(1);
      expect(result.advisories[0]!.id).toBe('GHSA-LIST');
    });

    it('should search within a repository and handle various data formats', async () => {
      vi.mocked(fetch).mockImplementation(async (url: any) => {
        const urlStr = typeof url === 'string' ? url : url.url;
        if (urlStr.includes('items')) {
           return { ok: true, json: async () => ({ items: [{ ghsa_id: 'GHSA-ITEMS' }] }) } as Response;
        }
        return { ok: true, json: async () => [{ ghsa_id: 'GHSA-REPO' }] } as Response;
      });

      const result = await searchGitHubAdvisories([], { repo: 'owner/repo' });
      expect(result.count).toBe(1);
      expect(result.advisories[0]!.id).toBe('GHSA-REPO');
    });

    it('should extract affected packages from different structures', async () => {
      const mockAdvisories = [
        {
          ghsa_id: 'GHSA-VULN-PKGS',
          vulnerabilities: [
            { package: { ecosystem: 'npm', name: 'pkg1' } },
            { affected: [{ package: { ecosystem: 'pip', name: 'pkg2' } }] }
          ]
        },
        {
          ghsa_id: 'GHSA-TOP-AFFECTED',
          affected: [{ package: { name: 'pkg3' } }]
        }
      ];

      vi.mocked(fetch).mockImplementation(async () => ({
        ok: true,
        json: async () => mockAdvisories,
      } as Response));

      const result = await searchGitHubAdvisories(['GHSA']);
      expect(result.advisories[0]!.affectedPackages).toContain('npm/pkg1');
      expect(result.advisories[0]!.affectedPackages).toContain('pip/pkg2');
      expect(result.advisories[1]!.affectedPackages).toContain('pkg3');
    });

    it('should handle errors in repo search', async () => {
      // 403 Rate Limit
      vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, status: 403 } as Response));
      // retryWithBackoff will call it again
      vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, status: 403 } as Response));
      vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, status: 403 } as Response));
      
      const res1 = await searchGitHubAdvisories([], { repo: 'a/b' });
      expect(res1.error).toContain('rate limit exceeded');
    });

    it('should deduplicate results by GHSA ID', async () => {
      const mockAdv = { ghsa_id: 'GHSA-DUP', summary: 'Duplicate' };
      vi.mocked(fetch).mockImplementation(async () => ({
        ok: true,
        json: async () => [mockAdv],
      } as Response));

      const result = await searchGitHubAdvisories(['GHSA-DUP', 'Duplicate']);
      expect(result.count).toBe(1);
    });
  });

  describe('getAdvisoryById', () => {
    it('should handle 404 in getAdvisoryById', async () => {
      vi.mocked(fetch).mockImplementation(async () => ({ ok: false, status: 404 } as Response));
      const result = await getAdvisoryById('MISSING');
      expect(result).toBeNull();
    });
  });
});
