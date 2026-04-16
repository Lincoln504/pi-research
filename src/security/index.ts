/**
 * Security Databases Module
 *
 * Main entry point for security database integrations
 * Combines multiple vulnerability database sources
 * Refactored with dependency injection for testability
 */

import type {
  SecuritySearchParams,
  SecuritySearchResult,
  INVDClient,
  ICisaKevClient,
  IGitHubAdvisoriesClient,
  IOSVClient,
  NVDSearchOptions,
  CisaKevSearchOptions,
  GitHubSearchOptions,
  OSVSearchOptions,
  NVDResult,
  CisaKevResult,
  GitHubResult,
  OSVResult,
} from './types.ts';
import { REQUEST_DELAY_MS } from '../constants.ts';
import { searchNVD } from './nvd.ts';
import { searchCisaKev } from './cisa-kev.ts';
import { searchGitHubAdvisories } from './github-advisories.ts';
import { searchOSV } from './osv.ts';

// ============================================================================
// Type Definitions
// ============================================================================

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface DatabaseInfo {
  readonly databases: readonly DatabaseInfoEntry[];
}

interface DatabaseInfoEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly free: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Type guard to check if a value is a valid Severity
 */
function isValidSeverity(value: unknown): value is Severity {
  return (
    typeof value === 'string' &&
    (value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL')
  );
}

/**
 * Safely extract severity from params, returning undefined if invalid
 */
function getSeverityParam(params: SecuritySearchParams): Severity | undefined {
  if (params.severity === undefined) {
    return undefined;
  }
  return isValidSeverity(params.severity) ? params.severity : undefined;
}

/**
 * Safely extract error message from unknown error
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// ============================================================================
// Security Searcher Class (with dependency injection)
// ============================================================================

/**
 * Configuration for SecuritySearcher
 */
export interface SecuritySearcherConfig {
  readonly nvdClient?: INVDClient;
  readonly cisaKevClient?: ICisaKevClient;
  readonly githubAdvisoriesClient?: IGitHubAdvisoriesClient;
  readonly osvClient?: IOSVClient;
  readonly requestDelay?: number; // milliseconds between requests
}

const DEFAULT_CONFIG: Required<SecuritySearcherConfig> = {
  nvdClient: null as unknown as INVDClient,
  cisaKevClient: null as unknown as ICisaKevClient,
  githubAdvisoriesClient: null as unknown as IGitHubAdvisoriesClient,
  osvClient: null as unknown as IOSVClient,
  requestDelay: REQUEST_DELAY_MS,
};

/**
 * SecuritySearcher - orchestrates searches across multiple security databases
 * Uses dependency injection for testability
 */
export class SecuritySearcher {
  private readonly config: Required<SecuritySearcherConfig>;

  constructor(config: Partial<SecuritySearcherConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main search function that queries multiple security databases
   */
  async search(params: SecuritySearchParams): Promise<SecuritySearchResult> {
    const startTime = Date.now();
    const results: { nvd?: NVDResult; cisa_kev?: CisaKevResult; github?: GitHubResult; osv?: OSVResult } = {};
    const errors: string[] = [];
    let totalVulnerabilities = 0;

    // Search each requested database
    if (params.databases.includes('nvd')) {
      try {
        const severity = getSeverityParam(params);
        const nvdResult = await this.searchNVD(
          params.terms,
          {
            severity: severity,
            maxResults: params.maxResults,
            includeExploited: params.includeExploited,
          },
        );
        results.nvd = nvdResult;
        totalVulnerabilities += nvdResult.count;
        if (nvdResult.error !== undefined) {
          errors.push(`NVD: ${nvdResult.error}`);
        }
      } catch (err: unknown) {
        errors.push(`NVD: ${getErrorMessage(err)}`);
      }
    }

    if (params.databases.includes('cisa_kev')) {
      try {
        const cisaResult = await this.searchCisaKev(params.terms, {
          maxResults: params.maxResults,
        });
        results.cisa_kev = cisaResult;
        totalVulnerabilities += cisaResult.count;
        if (cisaResult.error !== undefined) {
          errors.push(`CISA KEV: ${cisaResult.error}`);
        }
      } catch (err: unknown) {
        errors.push(`CISA KEV: ${getErrorMessage(err)}`);
      }
    }

    if (params.databases.includes('github')) {
      try {
        const githubResult = await this.searchGitHub(params.terms, {
          ecosystem: params.ecosystem,
          severity: params.severity,
          maxResults: params.maxResults,
          repo: params.githubRepo,
        });
        results.github = githubResult;
        totalVulnerabilities += githubResult.count;
        if (githubResult.error !== undefined) {
          errors.push(`GitHub: ${githubResult.error}`);
        }
      } catch (err: unknown) {
        errors.push(`GitHub: ${getErrorMessage(err)}`);
      }
    }

    if (params.databases.includes('osv')) {
      try {
        const osvResult = await this.searchOSV(params.terms, {
          ecosystem: params.ecosystem,
          severity: params.severity,
          maxResults: params.maxResults,
        });
        results.osv = osvResult;
        totalVulnerabilities += osvResult.count;
        if (osvResult.error !== undefined) {
          errors.push(`OSV: ${osvResult.error}`);
        }
      } catch (err: unknown) {
        errors.push(`OSV: ${getErrorMessage(err)}`);
      }
    }

    // Apply delay to avoid rate limiting
    if (this.config.requestDelay > 0) {
      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, this.config.requestDelay);
        timeoutId.unref();
      });
    }

    const duration = Date.now() - startTime;

    return {
      results,
      totalDatabases: Object.keys(results).length,
      totalVulnerabilities,
      duration,
    };
  }

  private async searchNVD(terms: readonly string[], options: NVDSearchOptions): Promise<import('./types.ts').NVDResult> {
    const client = this.config.nvdClient ?? createDefaultNVDClient();
    return client.search(terms, options);
  }

  private async searchCisaKev(terms: readonly string[], options: CisaKevSearchOptions): Promise<import('./types.ts').CisaKevResult> {
    const client = this.config.cisaKevClient ?? createDefaultCisaKevClient();
    return client.search(terms, options);
  }

  private async searchGitHub(terms: readonly string[], options: GitHubSearchOptions): Promise<import('./types.ts').GitHubResult> {
    const client = this.config.githubAdvisoriesClient ?? createDefaultGitHubClient();
    return client.search(terms, options);
  }

  private async searchOSV(terms: readonly string[], options: OSVSearchOptions): Promise<import('./types.ts').OSVResult> {
    const client = this.config.osvClient ?? createDefaultOSVClient();
    return client.search(terms, options);
  }
}

// ============================================================================
// Default Client Implementations (wrappers for existing functions)
// ============================================================================

class DefaultNVDClient implements INVDClient {
  async search(terms: readonly string[], options?: NVDSearchOptions): Promise<import('./types.ts').NVDResult> {
    return searchNVD(terms as string[], options);
  }

  async getById(cveId: string): Promise<import('./types.ts').Vulnerability | null> {
    const { getCVEById } = await import('./nvd.ts');
    return getCVEById(cveId);
  }
}

class DefaultCisaKevClient implements ICisaKevClient {
  async search(terms: readonly string[], options?: CisaKevSearchOptions): Promise<import('./types.ts').CisaKevResult> {
    return searchCisaKev(terms as string[], options);
  }
}

class DefaultGitHubClient implements IGitHubAdvisoriesClient {
  async search(terms: readonly string[], options?: GitHubSearchOptions): Promise<import('./types.ts').GitHubResult> {
    return searchGitHubAdvisories(terms as string[], options);
  }

  async getById(id: string): Promise<import('./types.ts').Advisory | null> {
    const { getAdvisoryById } = await import('./github-advisories.ts');
    return getAdvisoryById(id);
  }
}

class DefaultOSVClient implements IOSVClient {
  async search(terms: readonly string[], options?: OSVSearchOptions): Promise<import('./types.ts').OSVResult> {
    return searchOSV(terms as string[], options);
  }

  async getById(osvId: string): Promise<import('./types.ts').Vulnerability | null> {
    const { getOSVById } = await import('./osv.ts');
    return getOSVById(osvId);
  }
}

// Default client factories
function createDefaultNVDClient(): INVDClient {
  return new DefaultNVDClient();
}

function createDefaultCisaKevClient(): ICisaKevClient {
  return new DefaultCisaKevClient();
}

function createDefaultGitHubClient(): IGitHubAdvisoriesClient {
  return new DefaultGitHubClient();
}

function createDefaultOSVClient(): IOSVClient {
  return new DefaultOSVClient();
}

// ============================================================================
// Global State for Backward Compatibility
// ============================================================================

let globalSearcher: SecuritySearcher | null = null;

/**
 * Create a new security searcher instance
 */
export function createSecuritySearcher(
  config: Partial<SecuritySearcherConfig> = {}
): SecuritySearcher {
  return new SecuritySearcher(config);
}

/**
 * Get the global security searcher instance
 */
export function getSecuritySearcher(): SecuritySearcher {
  if (!globalSearcher) {
    globalSearcher = new SecuritySearcher();
  }
  return globalSearcher;
}

/**
 * Set the global security searcher instance (for testing)
 */
export function setSecuritySearcher(searcher: SecuritySearcher | null): void {
  globalSearcher = searcher;
}

/**
 * Reset the global security searcher instance (for testing)
 */
export function resetSecuritySearcher(): void {
  globalSearcher = null;
}

// ============================================================================
// Backward Compatibility Functions
// ============================================================================

/**
 * Main search function that queries multiple security databases
 * @deprecated Use SecuritySearcher class directly for better testability
 */
export async function searchSecurityDatabases(
  params: SecuritySearchParams,
): Promise<SecuritySearchResult> {
  const searcher = getSecuritySearcher();
  return searcher.search(params);
}

/**
 * Get database info for UI
 */
export function getDatabaseInfo(): DatabaseInfo {
  return {
    databases: [
      {
        id: 'nvd',
        name: 'NIST NVD',
        description: 'National Vulnerability Database - 340,000+ CVE records',
        url: 'https://nvd.nist.gov',
        free: true,
      },
      {
        id: 'cisa_kev',
        name: 'CISA KEV Catalog',
        description: 'Known Exploited Vulnerabilities - actively exploited vulnerabilities',
        url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
        free: true,
      },
      {
        id: 'github',
        name: 'GitHub Advisory Database',
        description: 'GitHub Security Advisories - open source security advisories',
        url: 'https://github.com/advisories',
        free: true,
      },
      {
        id: 'osv',
        name: 'Open Source Vulnerabilities',
        description: 'OSV - open source package vulnerabilities',
        url: 'https://osv.dev',
        free: true,
      },
    ] as const,
  };
}

// Export individual database search functions for direct use
export { searchNVD } from './nvd.ts';
export { searchCisaKev } from './cisa-kev.ts';
export { searchGitHubAdvisories } from './github-advisories.ts';
export { searchOSV } from './osv.ts';
