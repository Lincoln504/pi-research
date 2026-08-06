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
import { createTimeoutSignal, retryWithBackoff, isTransientError } from '../web-research/retry-utils.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { metrics } from '../utils/metrics.ts';
import { readJsonCapped, BodyTooLargeError, MAX_BULK_JSON_BODY_BYTES } from '../utils/http-body.ts';
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

  // Prefer v3.1 → v3.0 (unchanged behavior for the common case), then fall back to v4.0 and finally
  // v2 so CVEs carrying only a newer (v4) or older (v2) metric no longer report UNKNOWN/no-score.
  if (metrics?.cvssMetricV31 && metrics.cvssMetricV31.length > 0) {
    const cvssData = metrics.cvssMetricV31[0]?.cvssData;
    cvssScore = cvssData?.baseScore;
    cvssVector = cvssData?.vectorString;
    severity = cvssData?.baseSeverity ?? 'UNKNOWN';
  } else if (metrics?.cvssMetricV30 && metrics.cvssMetricV30.length > 0) {
    const cvssData = metrics.cvssMetricV30[0]?.cvssData;
    cvssScore = cvssData?.baseScore;
    cvssVector = cvssData?.vectorString;
    severity = cvssData?.baseSeverity ?? 'UNKNOWN';
  } else if (metrics?.cvssMetricV40 && metrics.cvssMetricV40.length > 0) {
    const cvssData = metrics.cvssMetricV40[0]?.cvssData;
    cvssScore = cvssData?.baseScore;
    cvssVector = cvssData?.vectorString;
    severity = cvssData?.baseSeverity ?? 'UNKNOWN';
  } else if (metrics?.cvssMetricV2 && metrics.cvssMetricV2.length > 0) {
    const m = metrics.cvssMetricV2[0];
    cvssScore = m?.cvssData?.baseScore;
    cvssVector = m?.cvssData?.vectorString;
    // v2 has no qualitative rating inside cvssData; use the NVD metric-level baseSeverity, and if
    // that is absent derive it from the score using CVSS v2 bands (v2 has no CRITICAL, caps at HIGH).
    severity = m?.baseSeverity ?? deriveV2Severity(cvssScore);
  }

  return { score: cvssScore, vector: cvssVector, severity };
}

/** Map a CVSS v2 base score (0-10) to its qualitative band. v2 has no CRITICAL rating. */
function deriveV2Severity(score: number | undefined): string {
  if (score === undefined) return 'UNKNOWN';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MEDIUM';
  if (score >= 0) return 'LOW';
  return 'UNKNOWN';
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

function extractNVDEntries(data: unknown): NVDEntry[] {
  if (!isNVDApiResponse(data) || !Array.isArray(data.vulnerabilities)) {
    return [];
  }
  return data.vulnerabilities.filter(isNVDEntry);
}

/**
 * True if a CVE carries a v3.1, v3.0, or v4.0 score. The v2 supplemental query
 * admits ONLY entries where this is false — the genuinely v2-only population that
 * the primary cvssV3Severity query cannot see — so a dual-rated CVE is never
 * re-admitted under a possibly-different v2 band than its authoritative v3/v4 one.
 */
function hasNewerCvssMetric(metrics: Metrics | undefined): boolean {
  return (
    (metrics?.cvssMetricV31?.length ?? 0) > 0 ||
    (metrics?.cvssMetricV30?.length ?? 0) > 0 ||
    (metrics?.cvssMetricV40?.length ?? 0) > 0
  );
}

/**
 * Which CVSS-severity query parameter to filter on. NVD 2.0's cvssV2Severity and
 * cvssV3Severity params only match a CVE that carries a metric of that specific
 * version — a CVE with no v3 score structurally cannot satisfy cvssV3Severity=X.
 * So a severity-filtered search must issue separate v3- and v2-filtered requests
 * and merge client-side (see searchSingleTerm) to also see CVEs that carry only a
 * v2 score (mostly pre-~2021). Default 'v3' preserves the original behavior.
 *
 * No 'v4' arm: today every v4-rated CVE also carries a v3.1 score, so a
 * cvssV4Severity pass would add a full extra request (tripling latency under the
 * shared rate limiter) for zero net coverage — and cvssV4Severity may not even be
 * a supported NVD 2.0 query param. Add a 'v4' arm here if that ever changes.
 */
type SeverityQueryVersion = 'v3' | 'v2';

function buildURL(
  term: string,
  options: SearchOptions | undefined,
  maxResults: number,
  startIndex: number = 0,
  severityVersion: SeverityQueryVersion = 'v3',
): string {
  const params = new URLSearchParams();

  params.append('keywordSearch', term);

  if (options?.severity) {
    params.append(severityVersion === 'v2' ? 'cvssV2Severity' : 'cvssV3Severity', options.severity);
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
    // Drain before throwing: an unconsumed error body pins its socket until GC,
    // and this path runs on every retry of a rate-limited/5xx sweep.
    void response.body?.cancel()?.catch(() => { /* best-effort */ });
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
      // Every attempt — the first AND each 2s/4s retry — must hold a rate-limiter
      // slot: the limiter's spacing is the ONLY mechanism enforcing NVD's ~6s
      // inter-request interval (the post-sweep sleep was removed), and an acquire
      // outside this closure let 429/5xx retries re-hit the API faster than it.
      await nvdRateLimiter.acquire(signal);
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

async function fetchPaginated(
  term: string,
  options: SearchOptions | undefined,
  maxResults: number,
  severityVersion: SeverityQueryVersion,
  admitEntry: (entry: NVDEntry) => boolean = () => true,
): Promise<Vulnerability[]> {
  const allVulnerabilities: Vulnerability[] = [];
  const maxPages = options?.maxPages ?? 5;
  // Scale the page size to the caller's request (bounded by NVD 2.0's 2000 resultsPerPage
  // ceiling), mirroring the GitHub-advisories client. The prior hard cap of 20 silently
  // truncated any request for >20×maxPages results; a larger page also means FEWER requests
  // for the same total, which is friendlier to NVD's aggressive rate limit, not worse.
  const pageSize = Math.min(MAX_RESULTS_PER_PAGE, maxResults);
  const signal = options?.signal;
  let startIndex = 0;
  let totalPagesFetched = 0;

  while (totalPagesFetched < maxPages && allVulnerabilities.length < maxResults) {
    if (signal?.aborted) break; // stop paginating promptly on cancel
    const url = buildURL(term, options, pageSize, startIndex, severityVersion);

    // No acquire here: fetchWithRetry acquires a rate-limiter slot per ATTEMPT,
    // so retries are spaced too — a second acquire would double-charge the page.
    const response = await fetchWithRetry(url, signal);
    let data: unknown;
    try {
      // A page can legitimately carry up to MAX_RESULTS_PER_PAGE (2000) full CVE
      // records, so pagination reads against the bulk cap rather than the default.
      data = await readJsonCapped(response, MAX_BULK_JSON_BODY_BYTES);
    } catch (err) {
      // A 200 with a truncated/HTML body (proxy or CDN error page) would otherwise
      // throw and discard this whole term. Stop paginating this term instead —
      // the pages already gathered are kept. An over-cap body degrades the same
      // way but is counted separately so the cause stays diagnosable.
      metrics.increment('nvd_search_errors_total', 1, {
        error_type: err instanceof BodyTooLargeError ? 'body_too_large' : 'malformed_json',
      });
      break;
    }

    // The RAW fetched count drives the "NVD has nothing left" stop decision; the
    // admission filter only decides what's KEPT. If a page returns 20 raw matches
    // but the v2-only filter admits 0 (all also had v3), that must NOT look like
    // exhaustion and truncate pagination — later pages may hold real v2-only rows.
    const rawEntries = extractNVDEntries(data);
    const admitted = rawEntries.filter(admitEntry).map((entry) => parseNVDEntry(entry, options));

    if (rawEntries.length === 0) {
      // No `term` label: the metrics registry keys counters by label set and is only
      // cleared by an explicit clearSession(), so labelling by the raw search term made
      // every distinct security query add a permanent entry for the life of a pi host
      // session — unbounded growth driven straight by user input.
      metrics.increment('nvd_cache_misses_total', 1);
      break;
    }
    metrics.increment('nvd_cache_hits_total', 1);

    allVulnerabilities.push(...admitted);

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

/**
 * CVSS v2 has no CRITICAL band (it tops out at HIGH, ≥7.0) — cvssV2Severity only
 * accepts LOW/MEDIUM/HIGH — so a CRITICAL (or unset) search has nothing meaningful
 * to ask the v2-filtered endpoint.
 */
function shouldSupplementWithV2(options: SearchOptions | undefined): boolean {
  return options?.severity !== undefined && options.severity !== 'CRITICAL';
}

async function searchSingleTerm(
  term: string,
  options: SearchOptions | undefined,
  maxResults: number,
): Promise<Vulnerability[]> {
  const primary = await fetchPaginated(term, options, maxResults, 'v3');

  if (!shouldSupplementWithV2(options)) {
    return primary;
  }

  try {
    // Supplemental pass: recover CVEs that carry ONLY a CVSS v2 score and are thus
    // invisible to the cvssV3Severity-filtered query above. Admit only entries with
    // no v3/v4 metric so the two result sets are disjoint by construction.
    const v2Only = await fetchPaginated(
      term,
      options,
      maxResults,
      'v2',
      (entry) => !hasNewerCvssMetric(entry.cve.metrics),
    );
    // `primary` first: a no-op given the disjoint construction, but if any entry
    // unexpectedly appears in both, the v3/v4-authoritative record wins the dedup.
    return deduplicateVulnerabilities([primary, v2Only]).slice(0, maxResults);
  } catch (err) {
    // A supplemental-fetch failure must NOT fail the term — degrade to v3 results.
    const errorType = err instanceof Error ? err.name : 'unknown';
    metrics.increment('nvd_search_errors_total', 1, { error_type: 'v2_supplement_failed', cause: errorType });
    return primary;
  }
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

