/**
 * Security Advisory Types
 *
 * Common types for security advisories
 */

/**
 * Standardized advisory interface
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

/**
 * GitHub API result
 */
export interface GitHubResult {
  count: number;
  advisories: Advisory[];
  error?: string;
}

/**
 * NVD API result
 */
export interface NVDResult {
  count: number;
  vulnerabilities: Advisory[];
  error?: string;
}

/**
 * OSV API result
 */
export interface OSVResult {
  count: number;
  vulnerabilities: Advisory[];
  error?: string;
}