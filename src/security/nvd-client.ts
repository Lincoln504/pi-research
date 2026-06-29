/**
 * NVD (National Vulnerability Database) API Client
 *
 * NIST National Vulnerability Database
 * API: https://services.nvd.nist.gov/rest/json/cves/2.0
 * Free public API, no authentication required
 *
 * Rate Limits (Free Tier):
 * - ~5 requests per 30 seconds
 * - 50 requests per rolling 30 seconds
 *
 * This module includes a rate limiter to respect these limits.
 */

import type { Vulnerability, NVDResult } from './types.ts';
import type {
  Metrics,
  CVE,
  NVDEntry,
  SearchOptions,
  RetryOptions,
} from './nvd-types.ts';
import { logger } from '../logger.ts';
import { createTimeoutSignal, retryWithBackoff, isTransientError } from '../web-research/retry-utils.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { metrics } from '../utils/metrics.ts';
import {
  isWeaknessDescription,
  isWeakness,
  isReference,
  isCPEMatch,
  isNode,
  isConfiguration,
  isDescription,
  isNVDEntry,
  isNVDApiResponse,
} from './nvd-types.ts';

const nvdCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 10000,
  name: 'NVD API',
  isTransientError: isTransientError
});

const NVD_BASE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS_PER_PAGE = 2000;

// ============================================================================
// NVD Rate Limiter
// ============================================================================

class NVDRateLimiter {
  private lastRequest: number = 0;
  // Without an API key NVD allows ~5 requests per 30s (→ 6s spacing). With a key
  // the ceiling rises ~10x, so the spacing can safely drop to ~0.6s. Read as a
  // getter (not a frozen field initializer) so a key set after module import is
  // still honored — and stays consistent with the per-request header in
  // createFetchOptions, which also reads the env each call.
  private get minInterval(): number {
    return process.env['NVD_API_KEY'] ? 600 : 6000;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const waitTime = Math.max(0, this.minInterval - (now - this.lastRequest));

    this.lastRequest = now + waitTime;

    if (waitTime > 0) {
      // Abortable: the spacing is up to 6s (no API key), so a caller cancel must
      // not be stuck behind it. On abort, throw so the caller stops paginating.
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, waitTime);
        safeUnref(timeoutId);
        const onAbort = () => {
          clearTimeout(timeoutId as unknown as ReturnType<typeof setTimeout>);
          reject(Object.assign(new Error('NVD search aborted'), { name: 'AbortError' }));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });

      metrics.increment('nvd_ratelimiter_wait_total', 1);
      metrics.observe('nvd_ratelimiter_wait_duration_ms', waitTime);
    }
  }
}

const nvdRateLimiter = new NVDRateLimiter();

// ============================================================================
// Helper Functions
// ============================================================================

function extractCVSSScore(metrics: Metrics | undefined): {
  readonly score: number | undefined;
  readonly vector: string | undefined;
  readonly severity: string;
} {
  let cvssScore: number | undefined;
  let cvssVector: string | undefined;
  let severity: string = 'UNKNOWN';

  if (metrics?.cvssMetricV31 && metrics.cvssMetricV31.length > 0) {
    const firstMetric = metrics.cvssMetricV31[0];
    const cvssData = firstMetric?.cvssData;
    cvssScore = cvssData?.baseScore;
    cvssVector = cvssData?.vectorString;
    severity = cvssData?.baseSeverity ?? 'UNKNOWN';
  } else if (metrics?.cvssMetricV30 && metrics.cvssMetricV30.length > 0) {
    const firstMetric = metrics.cvssMetricV30[0];
    const cvssData = firstMetric?.cvssData;
    cvssScore = cvssData?.baseScore;
    cvssVector = cvssData?.vectorString;
    severity = cvssData?.baseSeverity ?? 'UNKNOWN';
  }

  return { score: cvssScore, vector: cvssVector, severity };
}

function extractCWEs(cve: CVE): string[] {
  const cwes: string[] = [];

  if (cve.weaknesses) {
    for (const weakness of cve.weaknesses) {
      if (isWeakness(weakness) && weakness.description) {
        for (const desc of weakness.description) {
          if (isWeaknessDescription(desc) && typeof desc.value === 'string' && desc.value.startsWith('CWE-')) {
            cwes.push(desc.value);
          }
        }
      }
    }
  }

  return cwes;
}

function extractReferences(cve: CVE): string[] {
  const references: string[] = [];

  if (cve.references) {
    for (const ref of cve.references) {
      if (isReference(ref) && typeof ref.url === 'string') {
        references.push(ref.url);
      }
    }
  }

  return references;
}

function extractAffectedProducts(cve: CVE): string[] {
  const affectedProducts: string[] = [];

  if (cve.configurations) {
    for (const config of cve.configurations) {
      if (isConfiguration(config) && config.nodes) {
        for (const node of config.nodes) {
          if (isNode(node) && node.cpeMatch) {
            for (const match of node.cpeMatch) {
              if (isCPEMatch(match) && typeof match.criteria === 'string') {
                affectedProducts.push(match.criteria);
              }
            }
          }
        }
      }
    }
  }

  return affectedProducts;
}

function getCVEDescription(cve: CVE): string {
  if (cve.descriptions && cve.descriptions.length > 0) {
    const firstDesc = cve.descriptions[0];
    if (isDescription(firstDesc) && typeof firstDesc.value === 'string' && firstDesc.value.length > 0) {
      return firstDesc.value;
    }
  }
  return 'No description available';
}

function parseNVDEntry(nvdEntry: NVDEntry, options: SearchOptions | undefined): Vulnerability {
  const cve = nvdEntry.cve;
  const metrics = cve.metrics;

  const { score: cvssScore, vector: cvssVector, severity } = extractCVSSScore(metrics);
  const cwes = extractCWEs(cve);
  const references = extractReferences(cve);
  const affectedProducts = extractAffectedProducts(cve);
  const knownExploited = options?.includeExploited === true;

  return {
    id: cve.id ?? 'UNKNOWN',
    source: 'nvd',
    severity,
    description: getCVEDescription(cve),
    published: cve.published,
    modified: cve.lastModified,
    cvssScore,
    cvssVector,
    cwes,
    references,
    affectedProducts,
    fixes: [],
    knownExploited,
  };
}

function parseNVDResponse(data: unknown, options: SearchOptions | undefined): Vulnerability[] {
  if (!isNVDApiResponse(data)) {
    return [];
  }

  if (Array.isArray(data.vulnerabilities)) {
    return data.vulnerabilities
      .filter(isNVDEntry)
      .map((entry) => parseNVDEntry(entry, options));
  }

  return [];
}

function buildURL(term: string, options: SearchOptions | undefined, maxResults: number, startIndex: number = 0): string {
  const params = new URLSearchParams();

  params.append('keywordSearch', term);

  if (options?.severity) {
    params.append('cvssV3Severity', options.severity);
  }
  if (options?.includeExploited) {
    params.append('hasKev', '');
  }
  if (options?.cweId) {
    params.append('cweId', options.cweId);
  }
  if (options?.startDate && options.endDate) {
    params.append('pubStartDate', options.startDate);
    params.append('pubEndDate', options.endDate);
  }
  params.append('resultsPerPage', maxResults.toString());
  params.append('startIndex', startIndex.toString());

  return `${NVD_BASE_URL}?${params.toString()}`;
}

function createFetchOptions(signal?: AbortSignal): RequestInit {
  // An NVD API key raises the public rate limit from ~5 to ~50 requests per
  // 30s rolling window (and is sent as the `apiKey` header, not a bearer token).
  const apiKey = process.env['NVD_API_KEY'];
  return {
    headers: {
      'User-Agent': 'pi-research/2.0',
      'Accept': 'application/json',
      ...(apiKey ? { apiKey } : {}),
    },
    // Compose the caller signal with the per-request timeout so either aborts.
    signal: createTimeoutSignal(30000, signal),
  };
}

function handleFetchError(error: unknown): never {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'DOMException') {
      throw new Error(`NVD API timeout: ${error.message}`);
    }
    throw new Error(`NVD API network error: ${error.message}`);
  }
  throw new Error(`NVD API network error: ${String(error)}`);
}

function handleResponseStatus(response: Response): void {
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('NVD API rate limit exceeded (HTTP 429). Retrying with backoff...');
    }
    if (response.status >= 500) {
      throw new Error(`NVD server error (HTTP ${response.status}). Retrying with backoff...`);
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
}

function fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
  const retryOptions: RetryOptions = {
    maxRetries: 3,
    initialDelay: 2000,
    maxDelay: 10000,
    signal,
  };

  const endpoint = new URL(url).pathname;

  return nvdCircuitBreaker.execute(async () => {
    return retryWithBackoff(async () => {
      let response: Response;
      try {
        response = await fetch(url, createFetchOptions(signal));
        metrics.increment('nvd_requests_total', 1, { endpoint, status: 'success' });
        metrics.increment('nvd_ratelimiter_used_total', 1, { endpoint });
      } catch (error) {
        const errorType = error instanceof Error ? error.name : 'unknown';
        metrics.increment('nvd_requests_total', 1, { endpoint, status: 'error' });
        metrics.increment('nvd_errors_total', 1, { endpoint, error_type: errorType });
        handleFetchError(error);
      }
      handleResponseStatus(response);
      return response;
    }, retryOptions);
  });
}

async function searchSingleTerm(
  term: string,
  options: SearchOptions | undefined,
  maxResults: number,
): Promise<Vulnerability[]> {
  const allVulnerabilities: Vulnerability[] = [];
  const maxPages = options?.maxPages ?? 5;
  const pageSize = Math.min(20, maxResults);
  const signal = options?.signal;
  let startIndex = 0;
  let totalPagesFetched = 0;

  while (totalPagesFetched < maxPages && allVulnerabilities.length < maxResults) {
    if (signal?.aborted) break; // stop paginating promptly on cancel
    const url = buildURL(term, options, pageSize, startIndex);

    await nvdRateLimiter.acquire(signal);

    const response = await fetchWithRetry(url, signal);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      // A 200 with a truncated/HTML body (proxy or CDN error page) would otherwise
      // throw and discard this whole term. Stop paginating this term instead.
      metrics.increment('nvd_search_errors_total', 1, { error_type: 'malformed_json' });
      break;
    }

    const vulnerabilities = parseNVDResponse(data, options);
    
    if (vulnerabilities.length === 0) {
      metrics.increment('nvd_cache_misses_total', 1, { term });
    } else {
      metrics.increment('nvd_cache_hits_total', 1, { term });
    }
    
    if (vulnerabilities.length === 0) {
      break;
    }
    
    allVulnerabilities.push(...vulnerabilities);
    
    const responseData = data as Record<string, unknown> | undefined;
    if (responseData?.['totalResults'] !== undefined && typeof responseData['totalResults'] === 'number' && startIndex + pageSize >= responseData['totalResults']) {
      break;
    }
    
    startIndex += pageSize;
    totalPagesFetched++;
  }

  metrics.increment('nvd_pagination_requests_total', totalPagesFetched);
  metrics.observe('nvd_pagination_pages_fetched', totalPagesFetched);

  return allVulnerabilities.slice(0, maxResults);
}

function deduplicateVulnerabilities(vulnerabilityArrays: Vulnerability[][]): Vulnerability[] {
  const uniqueVulns = new Map<string, Vulnerability>();

  for (const termResults of vulnerabilityArrays) {
    for (const vuln of termResults) {
      if (!uniqueVulns.has(vuln.id)) {
        uniqueVulns.set(vuln.id, vuln);
      }
    }
  }

  return Array.from(uniqueVulns.values());
}

/**
 * Search NVD for vulnerabilities
 *
 * @param terms - Search terms (CVE IDs, keywords, CPE names)
 * @param options - Optional filters
 * @returns Promise<NVDResult> containing vulnerability search results
 */
export async function searchNVD(
  terms: string[],
  options?: SearchOptions,
): Promise<NVDResult> {
  const startTime = Date.now();
  const maxResults = Math.min(options?.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_PER_PAGE);
  const vulnerabilities: Vulnerability[] = [];
  let totalResults = 0;
  let error: string | undefined = undefined;

  try {
    const searchPromises = terms.map(
      (term: string) => searchSingleTerm(term, options, maxResults),
    );

    // allSettled (not all): a single failing term must not discard every other
    // term's successfully-fetched results.
    const settled = await Promise.allSettled(searchPromises);
    const allResults: Vulnerability[][] = [];
    const failures: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        allResults.push(r.value);
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        failures.push(`${terms[i] ?? `term#${i}`} (${reason})`);
        metrics.increment('nvd_search_errors_total', 1, { error_type: 'term_failed' });
      }
    });
    if (failures.length > 0) {
      error = `NVD lookup failed for ${failures.length}/${terms.length} term(s): ${failures.join('; ')}`;
    }

    const uniqueVulns = deduplicateVulnerabilities(allResults);

    totalResults = uniqueVulns.length;
    vulnerabilities.push(...uniqueVulns.slice(0, maxResults));

  } catch (err) {
    const errorType = err instanceof Error ? err.name : 'unknown';
    error = err instanceof Error ? err.message : String(err);
    metrics.increment('nvd_search_errors_total', 1, { error_type: errorType });
  } finally {
    const duration = Date.now() - startTime;
    metrics.observe('nvd_search_duration_ms', duration, { has_error: error ? 'true' : 'false' });
  }

  return {
    count: totalResults,
    vulnerabilities,
    error,
  };
}

/**
 * Get specific CVE by ID
 *
 * @param cveId - The CVE ID to fetch (e.g., "CVE-2023-1234")
 * @returns Promise<Vulnerability | null> containing the vulnerability or null if not found
 */
export async function getCVEById(cveId: string, signal?: AbortSignal): Promise<Vulnerability | null> {
  const startTime = Date.now();
  try {
    const results = await searchNVD([cveId], { maxResults: 1, signal });
    const duration = Date.now() - startTime;
    metrics.observe('nvd_cve_fetch_duration_ms', duration, { found: results.vulnerabilities.length > 0 ? 'true' : 'false' });
    return results.vulnerabilities[0] ?? null;
  } catch (err) {
    const duration = Date.now() - startTime;
    metrics.observe('nvd_cve_fetch_duration_ms', duration, { found: 'false', error: 'true' });
    metrics.increment('nvd_cve_fetch_errors_total', 1);
    logger.error(`[NVD] Error fetching CVE ${cveId}:`, err);
    return null;
  }
}