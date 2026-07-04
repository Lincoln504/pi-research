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
import { normalizeEcosystem } from './ecosystem.ts';
import { createTimeoutSignal, retryWithBackoff, isTransientError } from '../web-research/retry-utils.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { metrics } from '../utils/metrics.ts';
import { logger } from '../logger.ts';
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
  resetTimeoutMs: 10000,
  name: 'GitHub API',
  isTransientError: isTransientError
});

// ============================================================================
// Constants
// ============================================================================

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_MAX_RESULTS = 20;

/**
 * Build GitHub API request headers, attaching a bearer token when GITHUB_TOKEN
 * is set. Authentication raises the rate limit from 60/hr to 5000/hr — without
 * it the unauthenticated ceiling is hit almost immediately under real use.
 */
function githubHeaders(): Record<string, string> {
  const token = process.env['GITHUB_TOKEN'];
  return {
    'User-Agent': 'pi-research/2.0',
    Accept: 'application/vnd.github.v3+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

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
    readonly signal?: AbortSignal;
  },
): Promise<GitHubResult> {
  const startTime = Date.now();
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  // GitHub caps per_page at 100 server-side and these paths do not follow the Link header,
  // so a request for >100 silently returns ≤100 with no signal that more exist — a security
  // tool must not imply completeness it didn't fetch. Clamp the page size and warn.
  const perPage = Math.min(100, maxResults);
  if (maxResults > 100) {
    logger.warn(`[github-advisories] maxResults=${maxResults} exceeds GitHub's 100-per-page cap and these paths don't paginate; returning up to 100. Results may be incomplete.`);
  }
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
      // Constrain to GitHub's allowed owner/repo character set before interpolating
      // into the API path. encodeURIComponent already neutralises traversal, but this
      // rejects malformed input early instead of issuing a doomed request.
      const repoNameRe = /^[A-Za-z0-9._-]+$/;
      if (!repoNameRe.test(owner!) || !repoNameRe.test(name!)) {
        throw new Error(`Invalid repo format: "${options.repo}". Owner and name may only contain letters, digits, '.', '_' and '-'.`);
      }
      const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/security-advisories?per_page=${perPage}`;

      const response = await githubCircuitBreaker.execute(() => retryWithBackoff(async () => {
        const resp = await fetch(url, {
          headers: githubHeaders(),
          signal: createTimeoutSignal(10000, options?.signal),
        });

        if (!resp.ok) {
          // Drain before throwing: an unconsumed error body pins its socket until
          // GC, and the 403/5xx branches below are retried with backoff.
          void resp.body?.cancel()?.catch(() => { /* best-effort */ });
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
        signal: options?.signal,
      }));

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        metrics.increment('github_search_errors_total', 1, { error_type: 'malformed_json' });
        throw new Error('GitHub API returned a malformed JSON response (repo advisories).');
      }
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
      // Search global advisories. Each term is fetched independently through the
      // circuit breaker and settled in isolation (Promise.allSettled) so one bad
      // term — a transient 5xx, a malformed body, an exhausted retry — never
      // discards the advisories already gathered for the others.
      const fetchTerm = async (term: string): Promise<Advisory[]> => {
        const termUpper = term.toUpperCase();
        let apiUrl: string;
        let endpointType: string;

        if (termUpper.startsWith('CVE-')) {
          apiUrl = `${GITHUB_API_BASE}/advisories?cve_id=${encodeURIComponent(termUpper)}&per_page=${perPage}`;
          endpointType = 'cve_lookup';
        } else if (termUpper.startsWith('GHSA-')) {
          apiUrl = `${GITHUB_API_BASE}/advisories/${encodeURIComponent(term)}`;
          endpointType = 'ghsa_lookup';
        } else {
          // Server-side narrowing so the term can match beyond just the newest
          // `maxResults` global advisories. GitHub's /advisories endpoint has no
          // free-text search, but it does support `affects=<package>`; a single-token
          // term (npm/pip/maven package identifiers never contain whitespace, incl.
          // scoped `@scope/name` and `group:artifact`) is treated as a package name.
          // Multi-word terms keep the newest-N + client-side substring path, since
          // `affects` on a non-package phrase would just return nothing.
          const ecosystemParam =
            options?.ecosystem !== undefined && options.ecosystem !== ''
              ? `&ecosystem=${encodeURIComponent(normalizeEcosystem(options.ecosystem, 'github'))}`
              : '';
          const affectsParam = !/\s/.test(term) ? `&affects=${encodeURIComponent(term)}` : '';
          apiUrl = `${GITHUB_API_BASE}/advisories?per_page=${perPage}&state=published&direction=desc${ecosystemParam}${affectsParam}`;
          endpointType = 'search';
        }

        const response = await githubCircuitBreaker.execute(() => retryWithBackoff(async () => {
          const resp = await fetch(apiUrl, {
            headers: githubHeaders(),
            signal: createTimeoutSignal(10000, options?.signal),
          });

          if (!resp.ok) {
            // Same drain-before-throw as the repo-advisories fetch above.
            void resp.body?.cancel()?.catch(() => { /* best-effort */ });
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
          signal: options?.signal,
        }));

        // A 404 on a direct GHSA/CVE lookup means "no such advisory", not failure.
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          metrics.increment('github_search_errors_total', 1, { error_type: 'malformed_json', endpoint: endpointType });
          throw new Error(`GitHub API returned a malformed JSON response for term "${term}".`);
        }
        let items: readonly GitHubAdvisoryRaw[] = [];

        if (isGitHubAdvisoryArray(data)) {
          items = data;
        } else if (isSingleGitHubAdvisory(data)) {
          items = [data];
        } else if (isGitHubAdvisoryListResponse(data) && isArray(data.items)) {
          items = data.items.filter(isGitHubAdvisoryRaw);
        }

        metrics.increment(items.length > 0 ? 'github_cache_hits_total' : 'github_cache_misses_total', 1, { term, endpoint: endpointType });

        return items.map(mapGitHubAdvisory);
      };

      const settled = await Promise.allSettled(terms.map(fetchTerm));
      const termResults: Advisory[] = [];
      const failures: string[] = [];
      settled.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          termResults.push(...result.value);
        } else {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          // A direct-lookup 404 is an expected "not found", not a real failure.
          if (!reason.includes('HTTP 404')) failures.push(`${terms[i]} (${reason})`);
        }
      });
      if (failures.length > 0 && failures.length === terms.length) {
        // Every term failed — surface it; partial failures are tolerated silently.
        throw new Error(`All GitHub advisory lookups failed: ${failures.join('; ')}`);
      } else if (failures.length > 0) {
        error = `Some GitHub advisory lookups failed: ${failures.join('; ')}`;
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

          // Partial match for everything else. Include affectedPackages so a
          // server-side `affects=<package>` hit is not then dropped just because
          // the advisory summary/description doesn't repeat the package name.
          return (
            advId.includes(t) ||
            advCveId.includes(t) ||
            advSummary.includes(t) ||
            advDescription.includes(t) ||
            adv.affectedPackages.some(p => p.toLowerCase().includes(t))
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

