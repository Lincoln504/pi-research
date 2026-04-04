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
import { logger } from '../logger.js';
import { createTimeoutSignal, retryWithBackoff } from '../web-research/retry-utils.ts';

// ============================================================================
// Type Definitions
// ============================================================================

interface CVSSData {
  readonly version?: string;
  readonly vectorString?: string;
  readonly baseScore?: number;
  readonly baseSeverity?: string;
}

interface CVSSMetricV31 {
  readonly cvssData: CVSSData;
}

interface CVSSMetricV30 {
  readonly cvssData: CVSSData;
}

interface WeaknessDescription {
  readonly value?: string;
}

interface Weakness {
  readonly description?: WeaknessDescription[];
}

interface Reference {
  readonly url?: string;
}

interface CPEMatch {
  readonly criteria?: string;
}

interface Node {
  readonly cpeMatch?: CPEMatch[];
}

interface Configuration {
  readonly nodes?: Node[];
}

interface Description {
  readonly value?: string;
}

interface Metrics {
  readonly cvssMetricV31?: CVSSMetricV31[];
  readonly cvssMetricV30?: CVSSMetricV30[];
}

interface CVE {
  readonly id?: string;
  readonly descriptions?: Description[];
  readonly published?: string;
  readonly lastModified?: string;
  readonly metrics?: Metrics;
  readonly weaknesses?: Weakness[];
  readonly references?: Reference[];
  readonly configurations?: Configuration[];
}

interface NVDEntry {
  readonly cve: CVE;
}

interface NVDApiResponse {
  readonly vulnerabilities?: NVDEntry[];
}

// ============================================================================
// Type Guards
// ============================================================================

function isWeaknessDescription(value: unknown): value is WeaknessDescription {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value
  );
}

function isWeakness(value: unknown): value is Weakness {
  return (
    typeof value === 'object' &&
    value !== null &&
    'description' in value
  );
}

function isReference(value: unknown): value is Reference {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value
  );
}

function isCPEMatch(value: unknown): value is CPEMatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    'criteria' in value
  );
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cpeMatch' in value
  );
}

function isConfiguration(value: unknown): value is Configuration {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodes' in value
  );
}

function isDescription(value: unknown): value is Description {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value
  );
}

function isNVDEntry(value: unknown): value is NVDEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cve' in value
  );
}

function isNVDApiResponse(value: unknown): value is NVDApiResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'vulnerabilities' in value
  );
}

// ============================================================================
// Constants
// ============================================================================

const NVD_BASE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS_PER_PAGE = 2000;

// ============================================================================
// NVD Rate Limiter
//
// NVD API has rate limits (free tier: ~5 req/30s).
// This rate limiter ensures we stay within limits by:
// 1. Tracking time between requests
// 2. Waiting if necessary to respect the minimum interval
// ============================================================================

class NVDRateLimiter {
  private lastRequest: number = 0;
  // 6 seconds between requests to stay within ~5 req/30s limit
  private readonly minInterval: number = 6000;

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;

    if (elapsed < this.minInterval) {
      const waitTime = this.minInterval - elapsed;
      // Unref the timeout so it doesn't prevent process exit
      await new Promise<void>(resolve => {
        const timeoutId = setTimeout(resolve, waitTime);
        timeoutId.unref();
      });
    }

    this.lastRequest = Date.now();
  }
}

// Singleton rate limiter instance
const nvdRateLimiter = new NVDRateLimiter();

// ============================================================================
// Types for query options
// ============================================================================

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface SearchOptions {
  readonly severity?: Severity;
  readonly maxResults?: number;
  readonly includeExploited?: boolean;
  readonly cweId?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

interface RetryOptions {
  readonly maxRetries: number;
  readonly initialDelay: number;
  readonly maxDelay: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

function isKnownExploited(options: SearchOptions | undefined): boolean {
  return options?.includeExploited === true;
}

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
  const knownExploited = isKnownExploited(options);

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
    fixes: [], // NVD doesn't provide fix info directly
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

function buildURL(term: string, options: SearchOptions | undefined, maxResults: number): string {
  const params = new globalThis.URLSearchParams();

  // Add keyword search (supports multiple keywords with AND logic)
  params.append('keywordSearch', term);

  // Add optional filters
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

  return `${NVD_BASE_URL}?${params.toString()}`;
}

function createFetchOptions(): RequestInit {
  return {
    headers: {
      'User-Agent': 'pi-research/2.0',
      'Accept': 'application/json',
    },
    signal: createTimeoutSignal(30000), // 30s timeout
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
    // Handle rate limit specifically with a more helpful message
    if (response.status === 429) {
      throw new Error('NVD API rate limit exceeded (HTTP 429). Retrying with backoff...');
    }
    // Server errors (5xx) are also retryable
    if (response.status >= 500) {
      throw new Error(`NVD server error (HTTP ${response.status}). Retrying with backoff...`);
    }
    // Client errors (4xx except 429) are not retryable
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
}

function fetchWithRetry(url: string): Promise<Response> {
  const retryOptions: RetryOptions = {
    maxRetries: 3,
    initialDelay: 2000, // Start with 2s delay
    maxDelay: 10000, // Max 10s delay
  };

  return retryWithBackoff(async () => {
    let response: Response;
    try {
      response = await fetch(url, createFetchOptions());
    } catch (error) {
      handleFetchError(error);
    }
    handleResponseStatus(response);
    return response;
  }, retryOptions);
}

async function searchSingleTerm(
  term: string,
  options: SearchOptions | undefined,
  maxResults: number,
): Promise<Vulnerability[]> {
  const url = buildURL(term, options, maxResults);

  // Apply rate limiting before making the request
  await nvdRateLimiter.acquire();

  // Wrap fetch with retry logic for transient errors (rate limiting, server errors)
  const response = await fetchWithRetry(url);
  const data = await response.json();

  return parseNVDResponse(data, options);
}

function deduplicateVulnerabilities(vulnerabilityArrays: Vulnerability[][]): Vulnerability[] {
  const uniqueVulns = new Map<string, Vulnerability>();

  // Deduplicate by CVE ID
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
  const maxResults = Math.min(options?.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_PER_PAGE);
  const vulnerabilities: Vulnerability[] = [];
  let totalResults = 0;
  let error: string | undefined = undefined;

  try {
    // Search each term and combine results
    const searchPromises = terms.map(
      (term: string) => searchSingleTerm(term, options, maxResults),
    );

    const allResults = await Promise.all(searchPromises);
    const uniqueVulns = deduplicateVulnerabilities(allResults);

    totalResults = uniqueVulns.length;
    vulnerabilities.push(...uniqueVulns.slice(0, maxResults));

  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
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
export async function getCVEById(cveId: string): Promise<Vulnerability | null> {
  try {
    const results = await searchNVD([cveId], { maxResults: 1 });
    return results.vulnerabilities[0] ?? null;
  } catch (err) {
    logger.error(`[NVD] Error fetching CVE ${cveId}:`, err);
    return null;
  }
}
