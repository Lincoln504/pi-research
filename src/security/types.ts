/**
 * Security Module Types
 *
 * Type definitions for security database integrations
 */

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

export interface Advisory {
  readonly id: string;
  readonly source: string;
  readonly severity: string;
  readonly summary: string;
  readonly description?: string;
  readonly published: string;
  readonly modified: string;
  readonly cveId?: string;
  readonly references: readonly string[];
  readonly affectedPackages: readonly string[];
}

export interface NVDResult {
  readonly count: number;
  readonly vulnerabilities: readonly Vulnerability[];
  readonly error?: string;
}

export interface CisaKevResult {
  readonly count: number;
  readonly vulnerabilities: readonly Vulnerability[];
  readonly error?: string;
}

export interface GitHubResult {
  readonly count: number;
  readonly advisories: readonly Advisory[];
  readonly error?: string;
}

export interface OSVResult {
  readonly count: number;
  readonly vulnerabilities: readonly Vulnerability[];
  readonly error?: string;
}

export interface SecurityDatabaseResults {
  readonly nvd?: NVDResult;
  readonly cisa_kev?: CisaKevResult;
  readonly github?: GitHubResult;
  readonly osv?: OSVResult;
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
  readonly results: SecurityDatabaseResults;
  readonly totalDatabases: number;
  readonly totalVulnerabilities: number;
  readonly duration: number;
}

// ============================================================================
// Security API Client Interfaces (for dependency injection)
// ============================================================================

export interface INVDClient {
  search(terms: readonly string[], options?: NVDSearchOptions): Promise<NVDResult>;
  getById(cveId: string): Promise<Vulnerability | null>;
}

export interface NVDSearchOptions {
  readonly severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly maxResults?: number;
  readonly includeExploited?: boolean;
  readonly cweId?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface ICisaKevClient {
  search(terms: readonly string[], options?: CisaKevSearchOptions): Promise<CisaKevResult>;
}

export interface CisaKevSearchOptions {
  readonly vendor?: string;
  readonly product?: string;
  readonly maxResults?: number;
}

export interface IGitHubAdvisoriesClient {
  search(terms: readonly string[], options?: GitHubSearchOptions): Promise<GitHubResult>;
  getById(id: string): Promise<Advisory | null>;
}

export interface GitHubSearchOptions {
  readonly ecosystem?: string;
  readonly severity?: string;
  readonly maxResults?: number;
  readonly repo?: string;
}

export interface IOSVClient {
  search(terms: readonly string[], options?: OSVSearchOptions): Promise<OSVResult>;
  getById(osvId: string): Promise<Vulnerability | null>;
}

export interface OSVSearchOptions {
  readonly ecosystem?: string;
  readonly severity?: string;
  readonly maxResults?: number;
  readonly includeAffected?: boolean;
}
