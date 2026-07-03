import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchNVD } from '../../../src/security/nvd-client.ts';

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
      totalResults: 1,
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
      totalResults: 1,
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

  it('parses CVSS v4.0 metrics when no v3 metric is present (was reported UNKNOWN/no-score)', async () => {
    const mockResponse = {
      totalResults: 1,
      vulnerabilities: [{
        cve: {
          id: 'CVE-V40',
          metrics: { cvssMetricV40: [{ cvssData: { baseScore: 9.3, baseSeverity: 'CRITICAL' } }] },
        },
      }],
    };
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, json: async () => mockResponse } as Response));
    const searchPromise = searchNVD(['term']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;
    expect(result.vulnerabilities[0]!.cvssScore).toBe(9.3);
    expect(result.vulnerabilities[0]!.severity).toBe('CRITICAL');
  });

  it('parses CVSS v2 metrics (metric-level baseSeverity) when only v2 is present', async () => {
    const mockResponse = {
      totalResults: 1,
      vulnerabilities: [{
        cve: {
          id: 'CVE-V2',
          metrics: { cvssMetricV2: [{ cvssData: { baseScore: 7.5 }, baseSeverity: 'HIGH' }] },
        },
      }],
    };
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, json: async () => mockResponse } as Response));
    const searchPromise = searchNVD(['term']);
    await vi.runAllTimersAsync();
    const result = await searchPromise;
    expect(result.vulnerabilities[0]!.cvssScore).toBe(7.5);
    expect(result.vulnerabilities[0]!.severity).toBe('HIGH');
  });

  it('should extract complex data (CWEs, references, CPEs)', async () => {
    const mockResponse = {
      totalResults: 1,
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

  it('should build correct URL with options', async () => {
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, json: async () => ({}) } as Response));
    const searchPromise = searchNVD(['test'], { severity: 'CRITICAL', includeExploited: true, cweId: 'CWE-1' });
    await vi.runAllTimersAsync();
    await searchPromise;
    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toContain('cvssV3Severity=CRITICAL');
    expect(url).toContain('hasKev');
  });

  // A CVE carrying ONLY a v2 score is invisible to a cvssV3Severity-filtered query.
  // The supplemental v2 pass recovers it, without re-banding dual-rated CVEs.
  describe('v2-only severity recovery', () => {
    const v2Only = (id: string, sev: string) => ({
      cve: { id, metrics: { cvssMetricV2: [{ cvssData: { baseScore: 7.5 }, baseSeverity: sev }] } },
    });
    const v3 = (id: string, sev: string, score: number) => ({
      cve: { id, metrics: { cvssMetricV31: [{ cvssData: { baseScore: score, baseSeverity: sev } }] } },
    });
    // A CVE that carries BOTH a v3 and a v2 rating.
    const dualRated = (id: string) => ({
      cve: {
        id,
        metrics: {
          cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: 'CRITICAL' } }],
          cvssMetricV2: [{ cvssData: { baseScore: 7.5 }, baseSeverity: 'HIGH' }],
        },
      },
    });
    // Route by which severity param the URL carries.
    const routeBySeverityParam = (v3Vulns: unknown[], v2Vulns: unknown[]) =>
      vi.mocked(fetch).mockImplementation(async (url) => {
        const u = String(url);
        const vulns = u.includes('cvssV2Severity=') ? v2Vulns : u.includes('cvssV3Severity=') ? v3Vulns : [];
        return { ok: true, json: async () => ({ totalResults: vulns.length, vulnerabilities: vulns }) } as Response;
      });

    it('issues a cvssV2Severity supplemental query for a HIGH search', async () => {
      routeBySeverityParam([], [v2Only('CVE-V2-1', 'HIGH')]);
      const p = searchNVD(['term'], { severity: 'HIGH' });
      await vi.runAllTimersAsync();
      await p;
      const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.includes('cvssV2Severity=HIGH'))).toBe(true);
      expect(urls.some(u => u.includes('cvssV3Severity=HIGH'))).toBe(true);
    });

    it('recovers a v2-only CVE the v3 query cannot see', async () => {
      routeBySeverityParam([], [v2Only('CVE-V2-ONLY', 'HIGH')]);
      const p = searchNVD(['term'], { severity: 'HIGH' });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result.vulnerabilities.map(v => v.id)).toContain('CVE-V2-ONLY');
    });

    it('does NOT re-band a dual-rated CVE — v3=CRITICAL leaks into neither the HIGH v2 pass', async () => {
      // The dual-rated CVE has v2=HIGH, so a naive v2 pass would wrongly admit it
      // into a HIGH search even though its authoritative v3 rating is CRITICAL.
      routeBySeverityParam([v3('CVE-REAL-HIGH', 'HIGH', 7.8)], [dualRated('CVE-DUAL')]);
      const p = searchNVD(['term'], { severity: 'HIGH' });
      await vi.runAllTimersAsync();
      const result = await p;
      const ids = result.vulnerabilities.map(v => v.id);
      expect(ids).toContain('CVE-REAL-HIGH');
      expect(ids).not.toContain('CVE-DUAL'); // filtered out of the v2 pass (has a v3 metric)
    });

    it('skips the v2 pass entirely for CRITICAL (v2 has no CRITICAL band)', async () => {
      routeBySeverityParam([v3('CVE-CRIT', 'CRITICAL', 9.8)], [v2Only('CVE-SHOULD-NOT-APPEAR', 'HIGH')]);
      const p = searchNVD(['term'], { severity: 'CRITICAL' });
      await vi.runAllTimersAsync();
      const result = await p;
      const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.includes('cvssV2Severity='))).toBe(false);
      expect(result.vulnerabilities.map(v => v.id)).not.toContain('CVE-SHOULD-NOT-APPEAR');
    });

    it('degrades to v3 results when the v2 supplemental query fails', async () => {
      vi.mocked(fetch).mockImplementation(async (url) => {
        if (String(url).includes('cvssV2Severity=')) throw new Error('v2 endpoint boom');
        return { ok: true, json: async () => ({ totalResults: 1, vulnerabilities: [v3('CVE-V3-OK', 'HIGH', 7.7)] }) } as Response;
      });
      const p = searchNVD(['term'], { severity: 'HIGH' });
      for (let i = 0; i < 6; i++) await vi.runAllTimersAsync(); // let v2 retries exhaust
      const result = await p;
      expect(result.vulnerabilities.map(v => v.id)).toContain('CVE-V3-OK');
      expect(result.error).toBeUndefined(); // supplemental failure is not a term failure
    });
  });
});
