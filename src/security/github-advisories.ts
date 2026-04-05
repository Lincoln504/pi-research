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
import { logger } from '../logger.ts';
import { createTimeoutSignal, retryWithBackoff } from '../web-research/retry-utils.ts';

// ============================================================================
// Type Definitions for Fetch API
// ============================================================================

/**
 * Standard fetch API types for compatibility
 */
type FetchType = (
  _input: string | Request,
  _init?: RequestInit,
) => Promise<Response>;

declare const fetch: FetchType;

interface Headers {
  append(_name: string, _value: string): void;
  delete(_name: string): void;
  get(_name: string): string | null;
  has(_name: string): boolean;
  set(_name: string, _value: string): void;
  forEach(_callback: (_value: string, _name: string) => void): void;
}

interface Response {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly type: 'basic' | 'cors' | 'default' | 'error' | 'opaque' | 'opaqueredirect';
  readonly url: string;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  clone(): Response;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  formData(): Promise<FormData>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

// ============================================================================
// Type Definitions for GitHub API Responses
// ============================================================================

/**
 * GitHub Advisory Vulnerability Package
 */
interface GitHubAdvisoryPackage {
  readonly ecosystem?: string;
  readonly name?: string;
}

/**
 * GitHub Advisory Affected Entry
 */
interface GitHubAdvisoryAffected {
  readonly package?: GitHubAdvisoryPackage;
}

/**
 * GitHub Advisory Vulnerability
 */
interface GitHubAdvisoryVulnerability {
  readonly package?: GitHubAdvisoryPackage;
  readonly affected?: readonly GitHubAdvisoryAffected[];
}

/**
 * Raw GitHub Advisory from API response
 */
interface GitHubAdvisoryRaw {
  readonly ghsa_id?: string;
  readonly id?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly severity?: string;
  readonly published_at?: string;
  readonly updated_at?: string;
  readonly cve_id?: string;
  readonly html_url?: string;
  readonly advisory_url?: string;
  readonly vulnerabilities?: readonly GitHubAdvisoryVulnerability[];
  readonly affected?: readonly GitHubAdvisoryAffected[];
}

/**
 * GitHub API list response wrapper
 */
interface GitHubAdvisoryListResponse {
  readonly items?: readonly GitHubAdvisoryRaw[];
}


// ============================================================================
// Constants
// ============================================================================

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_MAX_RESULTS = 20;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if value is a GitHubAdvisoryRaw
 */
function isGitHubAdvisoryRaw(value: unknown): value is GitHubAdvisoryRaw {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return true;
}

/**
 * Type guard to check if value is an array
 */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Type guard to check if value is a string
 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Type guard to check if value is an object (non-null, non-array)
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isArray(value);
}

/**
 * Type guard for GitHubAdvisoryPackage
 */
function isGitHubAdvisoryPackage(value: unknown): value is GitHubAdvisoryPackage {
  if (!isObject(value)) {
    return false;
  }
  return true;
}

/**
 * Type guard for GitHubAdvisoryAffected
 */
function isGitHubAdvisoryAffected(value: unknown): value is GitHubAdvisoryAffected {
  if (!isObject(value)) {
    return false;
  }
  return true;
}

/**
 * Type guard for GitHubAdvisoryVulnerability
 */
function isGitHubAdvisoryVulnerability(value: unknown): value is GitHubAdvisoryVulnerability {
  if (!isObject(value)) {
    return false;
  }
  return true;
}

/**
 * Type guard to check if response is a list response with items
 */
function isGitHubAdvisoryListResponse(value: unknown): value is GitHubAdvisoryListResponse {
  if (!isObject(value)) {
    return false;
  }
  return 'items' in value;
}

/**
 * Type guard to check if response is an array of advisory objects
 */
function isGitHubAdvisoryArray(value: unknown): value is GitHubAdvisoryRaw[] {
  if (!isArray(value)) {
    return false;
  }
  return value.every(isGitHubAdvisoryRaw);
}

/**
 * Type guard to check if response is a single advisory object
 */
function isSingleGitHubAdvisory(value: unknown): value is GitHubAdvisoryRaw {
  if (!isGitHubAdvisoryRaw(value)) {
    return false;
  }
  // Single advisory typically has ghsa_id
  return 'ghsa_id' in value || 'summary' in value;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract affected packages from an advisory item
 */
function extractAffectedPackages(item: GitHubAdvisoryRaw): string[] {
  const affectedPackages: string[] = [];

  // Try different possible structures for affected packages
  // GitHub API response structure may vary between endpoints

  // Check for vulnerabilities array
  if (item.vulnerabilities !== undefined && isArray(item.vulnerabilities)) {
    for (const vuln of item.vulnerabilities) {
      if (!isGitHubAdvisoryVulnerability(vuln)) {
        continue;
      }

      // Check for package in various possible locations
      if (vuln.package !== undefined) {
        if (isGitHubAdvisoryPackage(vuln.package)) {
          const ecosystem = vuln.package.ecosystem ?? '';
          const name = vuln.package.name;

          if (isString(name) && name !== '') {
            if (ecosystem !== '') {
              affectedPackages.push(`${ecosystem}/${name}`);
            } else {
              affectedPackages.push(name);
            }
          }
        }
      } else if (vuln.affected !== undefined && isArray(vuln.affected)) {
        // Alternative structure with 'affected' array
        for (const aff of vuln.affected) {
          if (isGitHubAdvisoryAffected(aff) && aff.package !== undefined) {
            const pkg = aff.package;
            if (isGitHubAdvisoryPackage(pkg)) {
              const ecosystem = pkg.ecosystem ?? '';
              const name = pkg.name;

              if (isString(name) && name !== '') {
                if (ecosystem !== '') {
                  affectedPackages.push(`${ecosystem}/${name}`);
                } else {
                  affectedPackages.push(name);
                }
              }
            }
          }
        }
      }
    }
  }

  // Check for direct 'affected' array at the top level
  if (affectedPackages.length === 0 && item.affected !== undefined && isArray(item.affected)) {
    for (const aff of item.affected) {
      if (isGitHubAdvisoryAffected(aff) && aff.package !== undefined) {
        const pkg = aff.package;
        if (isGitHubAdvisoryPackage(pkg)) {
          const ecosystem = pkg.ecosystem ?? '';
          const name = pkg.name;

          if (isString(name) && name !== '') {
            if (ecosystem !== '') {
              affectedPackages.push(`${ecosystem}/${name}`);
            } else {
              affectedPackages.push(name);
            }
          }
        }
      }
    }
  }

  return affectedPackages;
}

/**
 * Extract references from an advisory item
 */
function extractReferences(item: GitHubAdvisoryRaw): string[] {
  const references: string[] = [];

  if (item.html_url !== undefined && item.html_url !== '') {
    references.push(item.html_url);
  }
  if (item.advisory_url !== undefined && item.advisory_url !== '') {
    references.push(item.advisory_url);
  }

  return references;
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
  },
): Promise<GitHubResult> {
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

      const response = await retryWithBackoff(async (): Promise<Response> => {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'pi-research/2.0',
            'Accept': 'application/vnd.github.v3+json',
          },
          signal: createTimeoutSignal(30000),
        });

        if (resp.ok === false) {
          if (resp.status === 404) {
            throw new Error(`Repository "${owner}/${name}" not found or no access to security advisories.`);
          }
          if (resp.status === 403) {
            throw new Error('GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...');
          }
          if (resp.status >= 500) {
            throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
          }
          throw new Error(`GitHub API error (${resp.status}): ${resp.statusText}`);
        }

        return resp;
      }, {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 5000,
      });

      const data = await response.json();
      let repoAdvisories: readonly GitHubAdvisoryRaw[] = [];

      if (isGitHubAdvisoryArray(data)) {
        repoAdvisories = data;
      } else if (isGitHubAdvisoryListResponse(data) && isArray(data.items)) {
        // Filter to ensure only valid advisory objects
        repoAdvisories = data.items.filter(isGitHubAdvisoryRaw);
      } else if (isSingleGitHubAdvisory(data)) {
        repoAdvisories = [data];
      }

      allAdvisories = repoAdvisories.map(mapGitHubAdvisory);
    } else {
      // Search global advisories.
      // The GitHub advisories API supports cve_id and ghsa_id as query params,
      // so use those for precise lookups; fall back to a general listing for
      // keyword terms (client-side filtering is applied afterwards).
      const termResults: Advisory[] = [];

      for (const term of terms) {
        const termUpper = term.toUpperCase();
        let apiUrl: string;

        if (termUpper.startsWith('CVE-')) {
          // Use cve_id param for CVE lookups
          apiUrl = `${GITHUB_API_BASE}/advisories?cve_id=${encodeURIComponent(termUpper)}&per_page=${maxResults}`;
        } else if (termUpper.startsWith('GHSA-')) {
          // Direct advisory lookup by GHSA ID
          apiUrl = `${GITHUB_API_BASE}/advisories/${encodeURIComponent(term)}`;
        } else {
          // Keyword: fetch recent published advisories and filter client-side
          apiUrl = `${GITHUB_API_BASE}/advisories?per_page=${maxResults}&state=published&direction=desc`;
        }

        const response = await retryWithBackoff(async (): Promise<Response> => {
          const resp = await fetch(apiUrl, {
            headers: {
              'User-Agent': 'pi-research/2.0',
              'Accept': 'application/vnd.github.v3+json',
            },
            signal: createTimeoutSignal(30000),
          });

          if (resp.ok === false) {
            if (resp.status === 404) {
              throw new Error('Advisory not found (HTTP 404)');
            }
            if (resp.status === 403) {
              throw new Error('GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...');
            }
            if (resp.status >= 500) {
              throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
            }
            throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
          }

          return resp;
        }, {
          maxRetries: 2,
          initialDelay: 1000,
          maxDelay: 5000,
        });

        const data = await response.json();
        let items: readonly GitHubAdvisoryRaw[] = [];

        // GHSA direct lookup returns an object; list endpoints return arrays
        if (isGitHubAdvisoryArray(data)) {
          items = data;
        } else if (isSingleGitHubAdvisory(data)) {
          items = [data];
        } else if (isGitHubAdvisoryListResponse(data) && isArray(data.items)) {
          items = data.items.filter(isGitHubAdvisoryRaw);
        }

        termResults.push(...items.map(mapGitHubAdvisory));
      }

      // Deduplicate by GHSA ID
      const seen = new Set<string>();
      for (const adv of termResults) {
        if (!seen.has(adv.id)) {
          seen.add(adv.id);
          allAdvisories.push(adv);
        }
      }
    }

    // Filter by search terms if provided (OR logic: match any term)
    if (terms.length > 0) {
      allAdvisories = allAdvisories.filter((adv): boolean =>
        terms.some((term): boolean => {
          const t = term.toLowerCase();
          const advId = adv.id.toLowerCase();
          const advSummary = adv.summary.toLowerCase();
          const advDescription = adv.description !== undefined
            ? adv.description.toLowerCase()
            : '';
          const advCveId = adv.cveId !== undefined
            ? adv.cveId.toLowerCase()
            : '';

          return (
            advId.includes(t) ||
            advCveId.includes(t) ||
            advSummary.includes(t) ||
            advDescription.includes(t)
          );
        }),
      );
    }

    // Filter by severity if provided
    // GitHub uses "MODERATE" where the rest of the industry uses "MEDIUM"
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
  try {
    if (id === '') {
      return null;
    }

    const url = `${GITHUB_API_BASE}/advisories/${encodeURIComponent(id)}`;

    const response = await retryWithBackoff(async (): Promise<Response> => {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'pi-research/2.0',
          'Accept': 'application/vnd.github.v3+json',
        },
        signal: createTimeoutSignal(30000),
      });

      if (resp.ok === false) {
        if (resp.status === 404) {
          throw new Error('Advisory not found (HTTP 404)');
        }
        if (resp.status === 403) {
          throw new Error('GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...');
        }
        if (resp.status >= 500) {
          throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
        }
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      return resp;
    }, {
      maxRetries: 2,
      initialDelay: 1000,
      maxDelay: 5000,
    });

    const data = await response.json();

    if (isGitHubAdvisoryRaw(data)) {
      return mapGitHubAdvisory(data);
    }

    return null;
  } catch (err: unknown) {
    // Check if it's a 404 error (not found) - return null instead of throwing
    if (err instanceof Error && err.message.includes('HTTP 404')) {
      logger.warn(`[GitHub Advisories] Advisory ${id} not found`);
      return null;
    }
    logger.error(`[GitHub Advisories] Error fetching advisory ${id}:`, err);
    return null;
  }
}

/**
 * Map GitHub advisory to our Advisory interface
 *
 * @param item - Raw GitHub advisory object
 * @returns Mapped Advisory object
 */
function mapGitHubAdvisory(item: GitHubAdvisoryRaw): Advisory {
  const ghsaId = item.ghsa_id ?? item.id ?? '';
  const summary = item.summary ?? '';
  const description = item.description ?? '';
  const severityRaw = item.severity ?? 'UNKNOWN';
  const severity = severityRaw.toUpperCase();
  const published = item.published_at ?? '';
  const modified = item.updated_at ?? '';
  const cveId = item.cve_id ?? '';

  const affectedPackages = extractAffectedPackages(item);
  const references = extractReferences(item);

  return {
    id: ghsaId,
    source: 'github',
    severity,
    summary,
    description,
    published,
    modified,
    cveId,
    references,
    affectedPackages,
  };
}
