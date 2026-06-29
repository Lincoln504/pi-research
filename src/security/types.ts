/**
 * Security Module Types
 *
 * Type definitions for security database integrations
 */

/**
 * Standardized advisory interface (mutable version for GitHub API)
 */
export interface Advisory {
  id: string;
  source: 'github' | 'nvd' | 'osv';
  severity: string;
  summary: string;
  description: string;
  published: string;
  modified: string;
  cveId?: string;
  references: string[];
  affectedPackages: string[];
  cvssScore?: number;
  cvssVector?: string;
  cwes?: string[];
  knownExploited?: boolean;
  fixes?: string[];
}

export interface Vulnerability {
  readonly id: string;
  readonly source: string;
  readonly severity: string;
  readonly description: string;
  readonly published?: string;
  readonly modified?: string;
  readonly cvssScore?: number;
  readonly cvssVector?: string;
  readonly cwes: readonly string[];
  readonly references: readonly string[];
  readonly affectedProducts: readonly string[];
  readonly fixes: readonly string[];
  readonly knownExploited?: boolean;
  readonly vendor?: string;
  readonly product?: string;
  readonly dueDate?: string;
  readonly requiredAction?: string;
}

export interface NVDResult {
  count: number;
  vulnerabilities: Vulnerability[];
  error?: string;
}

export interface CisaKevResult {
  count: number;
  vulnerabilities: Vulnerability[];
  error?: string;
}

export interface GitHubResult {
  count: number;
  advisories: Advisory[];
  error?: string;
}

export interface OSVResult {
  count: number;
  vulnerabilities: Vulnerability[];
  error?: string;
}

export interface SecurityDatabaseResults {
  nvd?: NVDResult;
  cisa_kev?: CisaKevResult;
  github?: GitHubResult;
  osv?: OSVResult;
}

export interface SecuritySearchParams {
  readonly terms: readonly string[];
  readonly databases: readonly ('nvd' | 'cisa_kev' | 'github' | 'osv')[];
  readonly severity?: string;
  readonly ecosystem?: string;
  readonly maxResults?: number;
  readonly includeExploited?: boolean;
  readonly githubRepo?: string;
}

export interface SecuritySearchResult {
  results: SecurityDatabaseResults;
  totalDatabases: number;
  totalVulnerabilities: number;
  duration: number;
}

// ============================================================================
// Security API Client Interfaces (for dependency injection)
// ============================================================================

export interface INVDClient {
  search(terms: readonly string[], options?: NVDSearchOptions): Promise<NVDResult>;
  getById(cveId: string, signal?: AbortSignal): Promise<Vulnerability | null>;
}

export interface NVDSearchOptions {
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  maxResults?: number;
  includeExploited?: boolean;
  cweId?: string;
  startDate?: string;
  endDate?: string;
  // Caller cancellation: composed with each request's own timeout and used to
  // short-circuit rate-limit/backoff waits and stop pagination promptly.
  signal?: AbortSignal;
}

export interface ICisaKevClient {
  search(terms: readonly string[], options?: CisaKevSearchOptions): Promise<CisaKevResult>;
}

export interface CisaKevSearchOptions {
  vendor?: string;
  product?: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface IGitHubAdvisoriesClient {
  search(terms: readonly string[], options?: GitHubSearchOptions): Promise<GitHubResult>;
  getById(id: string, signal?: AbortSignal): Promise<Advisory | null>;
}

export interface GitHubSearchOptions {
  ecosystem?: string;
  severity?: string;
  maxResults?: number;
  repo?: string;
  signal?: AbortSignal;
}

export interface IOSVClient {
  search(terms: readonly string[], options?: OSVSearchOptions): Promise<OSVResult>;
  getById(osvId: string, signal?: AbortSignal): Promise<Vulnerability | null>;
}

export interface OSVSearchOptions {
  ecosystem?: string;
  severity?: string;
  maxResults?: number;
  includeAffected?: boolean;
  signal?: AbortSignal;
}
