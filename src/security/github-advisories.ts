/**
 * GitHub Advisory Database API Client
 *
 * GitHub Security Advisories API
 * API: https://api.github.com/advisories
 * Free public API, rate limited (60/hr unauthenticated, 5000/hr authenticated)
 *
 * Rate limits are returned in headers:
 * - X-RateLimit-Limit: Total requests allowed
 * - X-RateLimit-Remaining: Requests remaining
 * - X-RateLimit-Reset: Unix timestamp when limit resets
 */

import type { Advisory, GitHubResult } from './types.ts';
import type { GitHubAdvisoryRaw } from './github-advisory-types.ts';
import { logger } from '../logger.ts';
import { createTimeoutSignal, retryWithBackoff, isTransientError } from '../web-research/retry-utils.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { metrics } from '../utils/metrics.ts';
import {
  isGitHubAdvisoryRaw,
  isArray,
  isGitHubAdvisoryListResponse,
  isGitHubAdvisoryArray,
  isSingleGitHubAdvisory,
  mapGitHubAdvisory,
} from './github-advisory-types.ts';

const githubCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  name: 'GitHub API',
  isTransientError: isTransientError
});

// ============================================================================
// Constants
// ============================================================================

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_MAX_RESULTS = 20;

// ============================================================================
// Main API Functions
// ============================================================================

/**
 * Search GitHub security advisories
 *
 * @param terms - Search terms (CVE IDs, GHSA IDs, package names)
 * @param options - Optional filters
 * @returns Promise<GitHubResult> containing matching advisories
 */
export async function searchGitHubAdvisories(
  terms: readonly string[],
  options?: {
    readonly ecosystem?: string;     // npm, pip, maven, go, etc.
    readonly severity?: string;      // LOW, MODERATE, HIGH, CRITICAL
    readonly maxResults?: number;
    readonly repo?: string;         // "owner/repo" format
  },
): Promise<GitHubResult> {
  const startTime = Date.now();
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const advisories: Advisory[] = [];
  let error: string | undefined = undefined;

  try {
    let allAdvisories: Advisory[] = [];

    // If repo specified, search repo-specific advisories
    if (options?.repo !== undefined && options.repo !== '') {
      const repoParts = options.repo.split('/');

      if (repoParts.length !== 2 || repoParts[0] === '' || repoParts[1] === '') {
        throw new Error(`Invalid repo format: "${options.repo}". Expected "owner/name".`);
      }

      const [owner, name] = repoParts;
      const url = `${GITHUB_API_BASE}/repos/${owner}/${name}/security-advisories?per_page=${maxResults}`;

      const response = await githubCircuitBreaker.execute(() => retryWithBackoff(async () => {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'pi-research/2.0',
            'Accept': 'application/vnd.github.v3+json',
          },
          signal: createTimeoutSignal(30000),
        });

        if (!resp.ok) {
          if (resp.status === 404) {
            throw new Error(`Repository "${owner}/${name}" not found or no access to security advisories.`);
          }
          if (resp.status === 403) {
            metrics.increment('github_ratelimit_hits_total', 1, { endpoint: 'repo_advisories' });
            throw new Error('GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...');
          }
          if (resp.status >= 500) {
            throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
          }
          throw new Error(`GitHub API error (${resp.status}): ${resp.statusText}`);
        }

        // Track rate limit headers
        const rateLimitRemaining = resp.headers?.get ? resp.headers.get('X-RateLimit-Remaining') : null;
        const rateLimitLimit = resp.headers?.get ? resp.headers.get('X-RateLimit-Limit') : null;
        if (rateLimitRemaining !== null) {
          metrics.setGauge('github_ratelimit_remaining', parseInt(rateLimitRemaining, 10), { endpoint: 'repo_advisories' });
        }
        if (rateLimitLimit !== null) {
          metrics.setGauge('github_ratelimit_limit', parseInt(rateLimitLimit, 10), { endpoint: 'repo_advisories' });
        }
        
        metrics.increment('github_requests_total', 1, { endpoint: 'repo_advisories', status: 'success' });
        return resp;
      }, {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 5000,
      }));

      const data = await response.json();
      let repoAdvisories: readonly GitHubAdvisoryRaw[] = [];

      if (isGitHubAdvisoryArray(data)) {
        repoAdvisories = data;
      } else if (isGitHubAdvisoryListResponse(data) && isArray(data.items)) {
        repoAdvisories = data.items.filter(isGitHubAdvisoryRaw);
      } else if (isSingleGitHubAdvisory(data)) {
        repoAdvisories = [data];
      }

      allAdvisories = repoAdvisories.map(mapGitHubAdvisory);
    } else {
      // Search global advisories
      const termResults: Advisory[] = [];

      for (const term of terms) {
        const termUpper = term.toUpperCase();
        let apiUrl: string;
        let endpointType: string;

        if (termUpper.startsWith('CVE-')) {
          apiUrl = `${GITHUB_API_BASE}/advisories?cve_id=${encodeURIComponent(termUpper)}&per_page=${maxResults}`;
          endpointType = 'cve_lookup';
        } else if (termUpper.startsWith('GHSA-')) {
          apiUrl = `${GITHUB_API_BASE}/advisories/${encodeURIComponent(term)}`;
          endpointType = 'ghsa_lookup';
        } else {
          apiUrl = `${GITHUB_API_BASE}/advisories?per_page=${maxResults}&state=published&direction=desc`;
          endpointType = 'search';
        }

        const response = await retryWithBackoff(async () => {
          const resp = await fetch(apiUrl, {
            headers: {
              'User-Agent': 'pi-research/2.0',
              'Accept': 'application/vnd.github.v3+json',
            },
            signal: createTimeoutSignal(30000),
          });

          if (!resp.ok) {
            if (resp.status === 404) {
              throw new Error('Advisory not found (HTTP 404)');
            }
            if (resp.status === 403) {
              metrics.increment('github_ratelimit_hits_total', 1, { endpoint: endpointType });
              throw new Error('GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...');
            }
            if (resp.status >= 500) {
              throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
            }
            throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
          }

          const rateLimitRemaining = resp.headers?.get ? resp.headers.get('X-RateLimit-Remaining') : null;
          const rateLimitLimit = resp.headers?.get ? resp.headers.get('X-RateLimit-Limit') : null;
          if (rateLimitRemaining !== null) {
            metrics.setGauge('github_ratelimit_remaining', parseInt(rateLimitRemaining, 10), { endpoint: endpointType });
          }
          if (rateLimitLimit !== null) {
            metrics.setGauge('github_ratelimit_limit', parseInt(rateLimitLimit, 10), { endpoint: endpointType });
          }          
          metrics.increment('github_requests_total', 1, { endpoint: endpointType, status: 'success' });
          return resp;
        }, {
          maxRetries: 2,
          initialDelay: 1000,
          maxDelay: 5000,
        });

        const data = await response.json();
        let items: readonly GitHubAdvisoryRaw[] = [];

        if (isGitHubAdvisoryArray(data)) {
          items = data;
        } else if (isSingleGitHubAdvisory(data)) {
          items = [data];
        } else if (isGitHubAdvisoryListResponse(data) && isArray(data.items)) {
          items = data.items.filter(isGitHubAdvisoryRaw);
        }
        
        metrics.increment(items.length > 0 ? 'github_cache_hits_total' : 'github_cache_misses_total', 1, { term, endpoint: endpointType });

        termResults.push(...items.map(mapGitHubAdvisory));
      }

      // Deduplicate by GHSA ID
      const seen = new Set<string>();
      for (const adv of termResults) {
        if (adv.id && !seen.has(adv.id)) {
          seen.add(adv.id);
          allAdvisories.push(adv);
        } else if (!adv.id) {
           allAdvisories.push(adv);
        }
      }
    }

    // Filter by search terms if provided (OR logic: match any term)
    if (terms.length > 0) {
      allAdvisories = allAdvisories.filter((adv): boolean => {
        if (terms.length === 0) return true;
        
        return terms.some((term): boolean => {
          const t = term.toLowerCase();
          const advId = (adv.id || '').toLowerCase();
          const advSummary = (adv.summary || '').toLowerCase();
          const advDescription = (adv.description || '').toLowerCase();
          const advCveId = (adv.cveId || '').toLowerCase();

          // Precise match for IDs
          if (advId === t || advCveId === t) return true;

          // Partial match for everything else
          return (
            advId.includes(t) ||
            advCveId.includes(t) ||
            advSummary.includes(t) ||
            advDescription.includes(t)
          );
        });
      });
    }

    // Filter by severity if provided
    if (options?.severity !== undefined && options.severity !== '') {
      const severity = options.severity.toUpperCase();
      const githubSeverity = severity === 'MEDIUM' ? 'MODERATE' : severity;
      allAdvisories = allAdvisories.filter((adv): boolean =>
        adv.severity === githubSeverity,
      );
    }

    advisories.push(...allAdvisories.slice(0, maxResults));

  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
    metrics.increment('github_search_errors_total', 1, { error_type: err instanceof Error ? err.name : 'unknown' });
  } finally {
    const duration = Date.now() - startTime;
    metrics.observe('github_search_duration_ms', duration, { has_error: error ? 'true' : 'false' });
  }

  return {
    count: advisories.length,
    advisories,
    error,
  };
}

/**
 * Get specific advisory by GHSA ID or CVE ID
 *
 * @param id - The GHSA ID or CVE ID to fetch
 * @returns Promise resolving to Advisory or null if not found
 */
export async function getAdvisoryById(id: string): Promise<Advisory | null> {
  const startTime = Date.now();
  try {
    if (id === '') {
      return null;
    }

    const url = `${GITHUB_API_BASE}/advisories/${encodeURIComponent(id)}`;

    const response = await githubCircuitBreaker.execute(() => retryWithBackoff(async () => {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'pi-research/2.0',
          'Accept': 'application/vnd.github.v3+json',
        },
        signal: createTimeoutSignal(30000),
      });

      if (!resp.ok) {
        if (resp.status === 404) {
          throw new Error('Advisory not found (HTTP 404)');
        }
        if (resp.status === 403) {
          metrics.increment('github_ratelimit_hits_total', 1, { endpoint: 'advisory_by_id' });
          throw new Error('GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...');
        }
        if (resp.status >= 500) {
          throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
        }
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const rateLimitRemaining = resp.headers.get('X-RateLimit-Remaining');
      const rateLimitLimit = resp.headers.get('X-RateLimit-Limit');
      if (rateLimitRemaining !== null) {
        metrics.setGauge('github_ratelimit_remaining', parseInt(rateLimitRemaining, 10), { endpoint: 'advisory_by_id' });
      }
      if (rateLimitLimit !== null) {
        metrics.setGauge('github_ratelimit_limit', parseInt(rateLimitLimit, 10), { endpoint: 'advisory_by_id' });
      }
      
      metrics.increment('github_requests_total', 1, { endpoint: 'advisory_by_id', status: 'success' });
      return resp;
    }, {
      maxRetries: 2,
      initialDelay: 1000,
      maxDelay: 5000,
    }));

    const data = await response.json();

    if (isGitHubAdvisoryRaw(data)) {
      const duration = Date.now() - startTime;
      metrics.observe('github_advisory_fetch_duration_ms', duration, { found: 'true' });
      return mapGitHubAdvisory(data);
    }

    const duration = Date.now() - startTime;
    metrics.observe('github_advisory_fetch_duration_ms', duration, { found: 'false' });
    return null;
  } catch (err: unknown) {
    const duration = Date.now() - startTime;
    metrics.observe('github_advisory_fetch_duration_ms', duration, { found: 'false', error: 'true' });
    metrics.increment('github_advisory_fetch_errors_total', 1);
    if (err instanceof Error && err.message.includes('HTTP 404')) {
      logger.warn(`[GitHub Advisories] Advisory ${id} not found`);
      return null;
    }
    logger.error(`[GitHub Advisories] Error fetching advisory ${id}:`, err);
    return null;
  }
}