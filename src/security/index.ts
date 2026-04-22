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
import { REQUEST_DELAY_MS_NVD, REQUEST_DELAY_MS_OTHER } from '../constants.ts';
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

function isValidSeverity(value: unknown): value is Severity {
  return (
    typeof value === 'string' &&
    (value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL')
  );
}

function getSeverityParam(params: SecuritySearchParams): Severity | undefined {
  if (params.severity === undefined) return undefined;
  return isValidSeverity(params.severity) ? params.severity : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ============================================================================
// Security Searcher Class
// ============================================================================

export interface SecuritySearcherConfig {
  readonly nvdClient?: INVDClient;
  readonly cisaKevClient?: ICisaKevClient;
  readonly githubAdvisoriesClient?: IGitHubAdvisoriesClient;
  readonly osvClient?: IOSVClient;
  readonly requestDelay?: number; // Override for testing
}

const DEFAULT_CONFIG: Required<SecuritySearcherConfig> = {
  nvdClient: null as unknown as INVDClient,
  cisaKevClient: null as unknown as ICisaKevClient,
  githubAdvisoriesClient: null as unknown as IGitHubAdvisoriesClient,
  osvClient: null as unknown as IOSVClient,
  requestDelay: -1, // Use database-specific logic by default
};

export class SecuritySearcher {
  private readonly config: Required<SecuritySearcherConfig>;

  constructor(config: Partial<SecuritySearcherConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async search(params: SecuritySearchParams): Promise<SecuritySearchResult> {
    const startTime = Date.now();
    const results: { nvd?: NVDResult; cisa_kev?: CisaKevResult; github?: GitHubResult; osv?: OSVResult } = {};
    const errors: string[] = [];
    let totalVulnerabilities = 0;

    const searchPromises: Promise<void>[] = [];

    if (params.databases.includes('nvd')) {
      searchPromises.push((async () => {
        try {
          const nvdResult = await this.searchNVD(params.terms, {
              severity: getSeverityParam(params),
              maxResults: params.maxResults,
              includeExploited: params.includeExploited,
          });
          results.nvd = nvdResult;
          totalVulnerabilities += nvdResult.count;
        } catch (err: unknown) {
          errors.push(`NVD: ${getErrorMessage(err)}`);
        }
      })());
    }

    if (params.databases.includes('cisa_kev')) {
      searchPromises.push((async () => {
        try {
          const cisaResult = await this.searchCisaKev(params.terms, { maxResults: params.maxResults });
          results.cisa_kev = cisaResult;
          totalVulnerabilities += cisaResult.count;
        } catch (err: unknown) {
          errors.push(`CISA KEV: ${getErrorMessage(err)}`);
        }
      })());
    }

    if (params.databases.includes('github')) {
      searchPromises.push((async () => {
        try {
          const githubResult = await this.searchGitHub(params.terms, {
            ecosystem: params.ecosystem,
            severity: params.severity,
            maxResults: params.maxResults,
            repo: params.githubRepo,
          });
          results.github = githubResult;
          totalVulnerabilities += githubResult.count;
        } catch (err: unknown) {
          errors.push(`GitHub: ${getErrorMessage(err)}`);
        }
      })());
    }

    if (params.databases.includes('osv')) {
      searchPromises.push((async () => {
        try {
          const osvResult = await this.searchOSV(params.terms, {
            ecosystem: params.ecosystem,
            severity: params.severity,
            maxResults: params.maxResults,
          });
          results.osv = osvResult;
          totalVulnerabilities += osvResult.count;
        } catch (err: unknown) {
          errors.push(`OSV: ${getErrorMessage(err)}`);
        }
      })());
    }

    await Promise.all(searchPromises);

    // Apply delay
    let delay = this.config.requestDelay;
    if (delay === -1) {
        delay = params.databases.includes('nvd') ? REQUEST_DELAY_MS_NVD : REQUEST_DELAY_MS_OTHER;
    }

    if (delay > 0) {
      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, delay);
        timeoutId.unref();
      });
    }

    return { results, totalDatabases: Object.keys(results).length, totalVulnerabilities, duration: Date.now() - startTime };
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
// Default Client Implementations
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

function createDefaultNVDClient(): INVDClient { return new DefaultNVDClient(); }
function createDefaultCisaKevClient(): ICisaKevClient { return new DefaultCisaKevClient(); }
function createDefaultGitHubClient(): IGitHubAdvisoriesClient { return new DefaultGitHubClient(); }
function createDefaultOSVClient(): IOSVClient { return new DefaultOSVClient(); }

// ============================================================================
// Global State
// ============================================================================

let globalSearcher: SecuritySearcher | null = null;

export function createSecuritySearcher(config: Partial<SecuritySearcherConfig> = {}): SecuritySearcher {
  return new SecuritySearcher(config);
}

export function getSecuritySearcher(): SecuritySearcher {
  if (!globalSearcher) globalSearcher = new SecuritySearcher();
  return globalSearcher;
}

export function setSecuritySearcher(searcher: SecuritySearcher | null): void { globalSearcher = searcher; }
export function resetSecuritySearcher(): void { globalSearcher = null; }

export async function searchSecurityDatabases(params: SecuritySearchParams): Promise<SecuritySearchResult> {
  return getSecuritySearcher().search(params);
}

export function getDatabaseInfo(): DatabaseInfo {
  return {
    databases: [
      { id: 'nvd', name: 'NIST NVD', description: 'National Vulnerability Database', url: 'https://nvd.nist.gov', free: true },
      { id: 'cisa_kev', name: 'CISA KEV Catalog', description: 'Known Exploited Vulnerabilities', url: 'https://www.cisa.gov', free: true },
      { id: 'github', name: 'GitHub Advisory Database', description: 'GitHub Security Advisories', url: 'https://github.com/advisories', free: true },
      { id: 'osv', name: 'Open Source Vulnerabilities', description: 'OSV - open source package vulnerabilities', url: 'https://osv.dev', free: true },
    ] as const,
  };
}

export { searchNVD } from './nvd.ts';
export { searchCisaKev } from './cisa-kev.ts';
export { searchGitHubAdvisories } from './github-advisories.ts';
export { searchOSV } from './osv.ts';
