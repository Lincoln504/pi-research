/**
 * GitHub Advisory API Types
 */

// ============================================================================
// Type Definitions for Fetch API
// ============================================================================

type FetchType = (
  _input: string | Request,
  _init?: RequestInit,
) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
export interface GitHubAdvisoryPackage {
  readonly ecosystem?: string;
  readonly name?: string;
}

/**
 * GitHub Advisory Affected Entry
 */
export interface GitHubAdvisoryAffected {
  readonly package?: GitHubAdvisoryPackage;
}

/**
 * GitHub Advisory Vulnerability
 */
export interface GitHubAdvisoryVulnerability {
  readonly package?: GitHubAdvisoryPackage;
  readonly affected?: readonly GitHubAdvisoryAffected[];
}

/**
 * Raw GitHub Advisory from API response
 */
export interface GitHubAdvisoryRaw {
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
export interface GitHubAdvisoryListResponse {
  readonly items?: readonly GitHubAdvisoryRaw[];
}

// ============================================================================
// Type Guards
// ============================================================================

export function isGitHubAdvisoryRaw(value: unknown): value is GitHubAdvisoryRaw {
  return typeof value === 'object' && value !== null;
}

export function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isArray(value);
}

export function isGitHubAdvisoryPackage(value: unknown): value is GitHubAdvisoryPackage {
  if (!isObject(value)) {
    return false;
  }
  return true;
}

export function isGitHubAdvisoryAffected(value: unknown): value is GitHubAdvisoryAffected {
  if (!isObject(value)) {
    return false;
  }
  return true;
}

export function isGitHubAdvisoryVulnerability(value: unknown): value is GitHubAdvisoryVulnerability {
  if (!isObject(value)) {
    return false;
  }
  return true;
}

export function isGitHubAdvisoryListResponse(value: unknown): value is GitHubAdvisoryListResponse {
  if (!isObject(value)) {
    return false;
  }
  return 'items' in value;
}

export function isGitHubAdvisoryArray(value: unknown): value is GitHubAdvisoryRaw[] {
  if (!isArray(value)) {
    return false;
  }
  return value.every(isGitHubAdvisoryRaw);
}

export function isSingleGitHubAdvisory(value: unknown): value is GitHubAdvisoryRaw {
  if (!isGitHubAdvisoryRaw(value)) {
    return false;
  }
  // Single advisory typically has ghsa_id
  return 'ghsa_id' in value || 'summary' in value;
}

import { type Advisory } from './types.ts';

/**
 * Extract affected packages from an advisory item
 */
export function extractAffectedPackages(item: GitHubAdvisoryRaw): string[] {
  const affectedPackages: string[] = [];

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
export function extractReferences(item: GitHubAdvisoryRaw): string[] {
  const references: string[] = [];

  if (item.html_url !== undefined && item.html_url !== '') {
    references.push(item.html_url);
  }
  if (item.advisory_url !== undefined && item.advisory_url !== '') {
    references.push(item.advisory_url);
  }

  return references;
}

/**
 * Map GitHub advisory to our Advisory interface
 */
export function mapGitHubAdvisory(item: GitHubAdvisoryRaw): Advisory {
  const ghsaId = item.ghsa_id ?? item.id ?? '';
  const summary = item.summary ?? '';
  const description = item.description ?? '';
  // Guard the type: isGitHubAdvisoryRaw validates only that the value is an object, so a
  // non-string severity (schema drift / numeric code) would throw on .toUpperCase() inside
  // the unguarded items.map(), failing the whole term in Promise.allSettled and discarding
  // every advisory for it.
  const severity = typeof item.severity === 'string' ? item.severity.toUpperCase() : 'UNKNOWN';
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