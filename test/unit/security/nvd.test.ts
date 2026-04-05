import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchNVD, getCVEById } from '../../../src/security/nvd.ts';

describe('NVD Client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should search NVD with multiple terms and deduplicate', async () => {
    const mockResponse = {
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2023-0001',
            descriptions: [{ value: 'Test description' }],
            metrics: {
              cvssMetricV31: [{
                cvssData: { baseScore: 7.5, baseSeverity: 'HIGH' }
              }]
            }
          }
        }
      ]
    };

    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      json: async () => mockResponse,
    } as Response));

    const searchPromise = searchNVD(['term1', 'term2']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;

    expect(result.count).toBe(1);
    expect(result.vulnerabilities[0]!.id).toBe('CVE-2023-0001');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('should handle deduplication with empty results', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      json: async () => ({ vulnerabilities: [] }),
    } as Response));

    const searchPromise = searchNVD(['term1']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;
    expect(result.count).toBe(0);
  });

  it('should parse CVSS v3.0 metrics if v3.1 is missing', async () => {
    const mockResponse = {
      vulnerabilities: [{
        cve: {
          id: 'CVE-V30',
          metrics: {
            cvssMetricV30: [{
              cvssData: { baseScore: 6.5, baseSeverity: 'MEDIUM' }
            }]
          }
        }
      }]
    };

    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      json: async () => mockResponse,
    } as Response));

    const searchPromise = searchNVD(['term']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;
    expect(result.vulnerabilities[0]!.cvssScore).toBe(6.5);
  });

  it('should extract complex data (CWEs, references, CPEs)', async () => {
    const mockResponse = {
      vulnerabilities: [{
        cve: {
          id: 'CVE-COMPLEX',
          weaknesses: [{ description: [{ value: 'CWE-79' }] }],
          references: [{ url: 'http://ref' }],
          configurations: [{
            nodes: [{ cpeMatch: [{ criteria: 'cpe:2.3:a:v:p:1:*:*:*:*:*:*:*' }] }]
          }]
        }
      }]
    };

    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      json: async () => mockResponse,
    } as Response));

    const searchPromise = searchNVD(['term']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;
    expect(result.vulnerabilities[0]!.cwes).toContain('CWE-79');
    expect(result.vulnerabilities[0]!.affectedProducts).toContain('cpe:2.3:a:v:p:1:*:*:*:*:*:*:*');
  });

  it('should handle 429 rate limit errors with retry', async () => {
    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { ok: false, status: 429 } as Response;
      return { ok: true, json: async () => ({ vulnerabilities: [] }) } as Response;
    });

    const searchPromise = searchNVD(['term']);
    for (let i = 0; i < 5; i++) await vi.runAllTimersAsync();
    await searchPromise;
    expect(callCount).toBe(2);
  });

  it('should handle non-retryable 4xx errors', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({ ok: false, status: 400, statusText: 'Bad' } as Response));
    const searchPromise = searchNVD(['term']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;
    expect(result.error).toContain('HTTP 400');
  });

  it('should handle network errors (non-Error)', async () => {
    vi.mocked(fetch).mockImplementation(async () => { throw 'string error'; });
    const searchPromise = searchNVD(['term']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;
    expect(result.error).toContain('string error');
  });

  it('should handle response with invalid format', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, json: async () => ({}) } as Response));
    const searchPromise = searchNVD(['term']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;
    expect(result.vulnerabilities).toEqual([]);
  });

  it('should get a single CVE by ID', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      json: async () => ({ vulnerabilities: [{ cve: { id: 'CVE-1' } }] }),
    } as Response));
    const getPromise = getCVEById('CVE-1');
    await vi.runAllTimersAsync();
    const result = await getPromise;
    expect(result?.id).toBe('CVE-1');
  });

  it('should handle getCVEById with error', async () => {
    vi.mocked(fetch).mockImplementation(async () => { throw new Error('Fail'); });
    const getPromise = getCVEById('CVE-1');
    await vi.runAllTimersAsync();
    const result = await getPromise;
    expect(result).toBeNull();
  });

  it('should build correct URL with options', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, json: async () => ({}) } as Response));
    const searchPromise = searchNVD(['test'], { severity: 'CRITICAL', includeExploited: true, cweId: 'CWE-1' });
    await vi.runAllTimersAsync();
    await searchPromise;
    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toContain('cvssV3Severity=CRITICAL');
    expect(url).toContain('hasKev');
  });
});
