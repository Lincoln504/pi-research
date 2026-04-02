/**
 * Security Databases Module
 *
 * Main entry point for security database integrations
 * Combines multiple vulnerability database sources
 */

import { searchNVD } from './nvd.ts';
import { searchCisaKev } from './cisa-kev.ts';
import { searchGitHubAdvisories } from './github-advisories.ts';
import { searchOSV } from './osv.ts';
import type {
  SecuritySearchParams,
  SecuritySearchResult,
  SecurityDatabaseResults,
} from './types.ts';

// ============================================================================
// Type Definitions
// ============================================================================

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Type guard to check if a value is a valid Severity
 */
function isValidSeverity(value: unknown): value is Severity {
  return (
    typeof value === 'string' &&
    (value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL')
  );
}

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
// Main Search Function
// ============================================================================

/**
 * Main search function that queries multiple security databases
 */
export async function searchSecurityDatabases(
  params: SecuritySearchParams,
): Promise<SecuritySearchResult> {
  const startTime = Date.now();
  const results: SecurityDatabaseResults = {};
  const errors: string[] = [];
  let totalVulnerabilities = 0;

  // Search each requested database
  if (params.databases.includes('nvd')) {
    try {
      const severity = getSeverityParam(params);
      const nvdResult = await searchNVD(params.terms, {
        severity: severity,
        maxResults: params.maxResults,
        includeExploited: params.includeExploited,
      });
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
      const cisaResult = await searchCisaKev(params.terms, {
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
      const githubResult = await searchGitHubAdvisories(params.terms, {
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
      const osvResult = await searchOSV(params.terms, {
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

  // 6.5-second buffer to avoid rate limiting
  await new Promise<void>(resolve => {
    const timeoutId = setTimeout(resolve, 6500);
    timeoutId.unref();
  });

  const duration = Date.now() - startTime;

  return {
    results,
    totalDatabases: Object.keys(results).length,
    totalVulnerabilities,
    duration,
  };
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
