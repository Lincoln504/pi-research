import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchCisaKev } from '../../../src/security/cisa-kev.ts';

describe('CISA KEV Client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('should fetch and parse CISA KEV data successfully (array format)', async () => {
    const mockData = [
      {
        cveID: 'CVE-2023-0001',
        vendorProject: 'Vendor A',
        product: 'Product A',
        vulnerabilityName: 'Vuln A',
        shortDescription: 'Description A',
        dateAdded: '2023-01-01',
        dueDate: '2023-01-21',
        requiredAction: 'Apply patch'
      }
    ];

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await searchCisaKev();

    expect(result.count).toBe(1);
    expect(result.vulnerabilities[0]!.id).toBe('CVE-2023-0001');
  });

  it('should filter by search terms', async () => {
    const mockData = [
      { cveID: 'CVE-1', description: 'Matched' },
      { cveID: 'CVE-2', description: 'irrelevant' }
    ];

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await searchCisaKev(['Matched']);
    expect(result.count).toBe(1);
    expect(result.vulnerabilities[0]!.id).toBe('CVE-1');
  });

  it('should sort by due date correctly including undefined', async () => {
    const mockData = [
      { cveID: 'CVE-2', dueDate: '2023-12-31' },
      { cveID: 'CVE-1', dueDate: '2023-01-01' },
      { cveID: 'CVE-3', dueDate: undefined }
    ];

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await searchCisaKev();
    expect(result.vulnerabilities[0]!.id).toBe('CVE-1');
    expect(result.vulnerabilities[1]!.id).toBe('CVE-2');
    expect(result.vulnerabilities[2]!.id).toBe('CVE-3');
  });

  it('should handle non-Error exceptions', async () => {
    vi.mocked(fetch).mockImplementationOnce(() => { throw 'string error'; });
    const result = await searchCisaKev();
    expect(result.error).toBe('string error');
  });

  it('should handle isCisaKevItem returning false (non-object item)', async () => {
    // To reach the filter(isCisaKevItem) line, it must be a CisaKevResponse with vulnerabilities array
    const mockResponse = {
      vulnerabilities: [null, { cveID: 'VALID' }]
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await searchCisaKev();
    expect(result.count).toBe(1);
    expect(result.vulnerabilities[0]!.id).toBe('VALID');
  });

  it('should handle extractCisaKevItems returning empty array', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ not_vulnerabilities: [] }),
    } as Response);

    const result = await searchCisaKev();
    expect(result.count).toBe(0);
  });
});
