/**
 * OSV (Open Source Vulnerabilities) API Client
 *
 * Open Source Vulnerabilities
 * API: https://api.osv.dev/v1/
 * Free public API, no authentication required
 */

import type { Vulnerability, OSVResult } from './types.ts';
import type { OsvVulnerability, OsvQueryRequest } from './osv-types.ts';
import { createTimeoutSignal, retryWithBackoff, isTransientError } from '../web-research/retry-utils.ts';
import { logger } from '../logger.ts';
import { OSV_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_INITIAL_DELAY_MS, DEFAULT_MAX_DELAY_MS } from '../constants.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { metrics } from '../utils/metrics.ts';
import {
  isOsvVulnerability,
  isOsvQueryResponse,
  mapOsvItemToVulnerability,
} from './osv-types.ts';

const osvCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 10000,
  name: 'OSV API',
  isTransientError: isTransientError
});

const OSV_BASE_URL = 'https://api.osv.dev/v1';
const DEFAULT_MAX_RESULTS = 20;

/**
 * Fetch with retry for resilience
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const endpoint = new URL(url).pathname;
  return osvCircuitBreaker.execute(async () => {
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, options);
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as Error & { status?: number };
          error.status = response.status;
          metrics.increment('osv_errors_total', 1, { endpoint, status_code: response.status.toString() });
          if (response.status === 429) {
            metrics.increment('osv_ratelimit_hits_total', 1, { endpoint });
          }
          throw error;
        }
        metrics.increment('osv_requests_total', 1, { endpoint, status: 'success' });
        return response;
      },
      {
        maxRetries: DEFAULT_MAX_RETRIES,
        initialDelay: DEFAULT_INITIAL_DELAY_MS,
        maxDelay: DEFAULT_MAX_DELAY_MS,
        label: `OSV API: ${url}`,
        signal,
        isTransientError: (error) => {
          const status = (error as Error & { status?: number })?.status;
          if (typeof status === 'number') {
            return status === 429 || status === 403 || status >= 500;
          }
          return isTransientError(error);
        },
      },
    );
  });
}

/**
 * Search OSV for vulnerabilities
 *
 * @param terms - Package names, CVE IDs, or keywords
 * @param options - Optional filters
 * @returns OSV search result with vulnerabilities and optional error
 */
export async function searchOSV(
  terms: string[],
  options?: {
    ecosystem?: string;
    severity?: string;
    maxResults?: number;
    includeAffected?: boolean;
    signal?: AbortSignal;
  },
): Promise<OSVResult> {
  const startTime = Date.now();
  const maxResults: number = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const vulnerabilities: Vulnerability[] = [];
  let error: string | undefined = undefined;

  try {
    // Each term is fetched and settled independently so one failed term (a
    // transient 5xx, a malformed body, an exhausted retry) never discards the
    // vulnerabilities already gathered for the others. `skipped` flags a package
    // term that needs the ecosystem parameter.
    const fetchTerm = async (term: string): Promise<{ vulns: Vulnerability[]; skipped: boolean }> => {
      const termUpper: string = term.toUpperCase();
      const isIdLookup =
        termUpper.startsWith('CVE-') || termUpper.startsWith('GHSA-') || termUpper.startsWith('OSV-');
      let response: Response;

      if (isIdLookup) {
        const normalizedId: string = termUpper.startsWith('GHSA-')
          ? `GHSA-${term.slice(term.indexOf('-') + 1).toLowerCase()}`
          : termUpper;
        const url: string = `${OSV_BASE_URL}/vulns/${encodeURIComponent(normalizedId)}`;
        response = await fetchWithRetry(url, {
          headers: { 'User-Agent': 'pi-research/2.0', 'Accept': 'application/json' },
          signal: createTimeoutSignal(OSV_TIMEOUT_MS, options?.signal),
        }, options?.signal);
      } else {
        if (options?.ecosystem === undefined || options.ecosystem === '') {
          return { vulns: [], skipped: true };
        }
        const body: OsvQueryRequest = { package: { name: term, ecosystem: options.ecosystem } };
        response = await fetchWithRetry(`${OSV_BASE_URL}/query`, {
          method: 'POST',
          headers: {
            'User-Agent': 'pi-research/2.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: createTimeoutSignal(OSV_TIMEOUT_MS, options?.signal),
        }, options?.signal);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        metrics.increment('osv_search_errors_total', 1, { error_type: 'malformed_json' });
        throw new Error(`OSV returned a malformed JSON response for "${term}".`);
      }

      let items: OsvVulnerability[];
      if (isOsvVulnerability(data)) {
        items = [data];
      } else if (isOsvQueryResponse(data)) {
        items = data.vulns ?? [];
      } else {
        logger.warn(`OSV returned unexpected format for "${term}"`);
        return { vulns: [], skipped: false };
      }

      const endpoint = isIdLookup ? 'vulns_by_id' : 'query';
      metrics.increment(items.length > 0 ? 'osv_cache_hits_total' : 'osv_cache_misses_total', 1, { term, endpoint });

      const vulns: Vulnerability[] = [];
      for (const item of items) {
        const vuln: Vulnerability = mapOsvItemToVulnerability(item);
        if (options?.severity !== undefined && options.severity !== '') {
          if (vuln.severity !== options.severity.toUpperCase()) continue;
        }
        vulns.push(vuln);
      }
      return { vulns, skipped: false };
    };

    const settled = await Promise.allSettled(terms.map(fetchTerm));
    const allVulns: Vulnerability[] = [];
    let skippedNoEcosystem = 0;
    const failures: string[] = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allVulns.push(...result.value.vulns);
        if (result.value.skipped) skippedNoEcosystem++;
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        // A 404 on an ID lookup means "no such vuln", not a real failure.
        if (!reason.includes('HTTP 404')) failures.push(`${terms[i]} (${reason})`);
      }
    });

    const uniqueVulns = new Map<string, Vulnerability>();
    for (const vuln of allVulns) {
      if (!uniqueVulns.has(vuln.id)) {
        uniqueVulns.set(vuln.id, vuln);
      }
    }

    vulnerabilities.push(...Array.from(uniqueVulns.values()));

    if (failures.length > 0 && failures.length === terms.length) {
      throw new Error(`All OSV lookups failed: ${failures.join('; ')}`);
    }
    const notes: string[] = [];
    if (failures.length > 0) notes.push(`Some OSV lookups failed: ${failures.join('; ')}`);
    if (skippedNoEcosystem > 0) {
      notes.push(`${skippedNoEcosystem} term(s) require the ecosystem parameter for OSV package search (e.g., ecosystem: "npm"). CVE/GHSA/OSV IDs work without it.`);
    }
    if (notes.length > 0) error = notes.join(' ');

  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
    metrics.increment('osv_search_errors_total', 1, { error_type: err instanceof Error ? err.name : 'unknown' });
  } finally {
    const duration = Date.now() - startTime;
    metrics.observe('osv_search_duration_ms', duration, { has_error: error ? 'true' : 'false' });
  }

  return {
    count: vulnerabilities.length,
    vulnerabilities: vulnerabilities.slice(0, maxResults),
    error,
  };
}

/**
 * Get vulnerability by OSV ID
 *
 * @param osvId - OSV vulnerability ID (e.g., CVE-2023-1234, GHSA-abc1-23de-fg45)
 * @returns Vulnerability object if found, null otherwise
 */
export async function getOSVById(osvId: string): Promise<Vulnerability | null> {
  const startTime = Date.now();
  try {
    const url: string = `${OSV_BASE_URL}/vulns/${encodeURIComponent(osvId)}`;
    const response: Response = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'pi-research/2.0',
        'Accept': 'application/json',
      },
      signal: createTimeoutSignal(OSV_TIMEOUT_MS),
    });

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      const duration = Date.now() - startTime;
      metrics.observe('osv_vuln_fetch_duration_ms', duration, { found: 'false', error: 'true' });
      metrics.increment('osv_vuln_fetch_errors_total', 1);
      logger.error(`OSV ${osvId} returned malformed JSON`);
      return null;
    }

    if (!isOsvVulnerability(data)) {
      const duration = Date.now() - startTime;
      metrics.observe('osv_vuln_fetch_duration_ms', duration, { found: 'false' });
      logger.error(`OSV ${osvId} returned unexpected format`);
      return null;
    }

    const duration = Date.now() - startTime;
    metrics.observe('osv_vuln_fetch_duration_ms', duration, { found: 'true' });
    return mapOsvItemToVulnerability(data);
  } catch (err: unknown) {
    const duration = Date.now() - startTime;
    metrics.observe('osv_vuln_fetch_duration_ms', duration, { found: 'false', error: 'true' });
    metrics.increment('osv_vuln_fetch_errors_total', 1);
    logger.error(`Error fetching OSV ${osvId}:`, err);
    return null;
  }
}