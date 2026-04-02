/**
 * Security Database Types
 *
 * Shared types for vulnerability database integrations
 */

export interface Vulnerability {
  id: string;           // CVE ID or equivalent identifier
  source: string;         // Database source: "nvd", "cisa_kev", "osv", "github"
  severity: string;      // LOW, MEDIUM, HIGH, CRITICAL
  description: string;
  published?: string;     // ISO 8601 date string
  modified?: string;      // ISO 8601 date string
  cvssScore?: number;   // CVSS base score (0-10)
  cvssVector?: string;    // CVSS vector string
  cwes?: string[];       // CWE identifiers
  references?: string[];   // Advisory URLs, vendor advisories, etc.
  affectedProducts?: string[]; // Affected CPE strings or package names
  fixes?: string[];      // Patch information, fixed versions, etc.
  vendor?: string;        // Vendor/organization name
  product?: string;       // Product name
  knownExploited?: boolean; // Whether actively exploited in the wild
  dueDate?: string;      // CISA KEV due date
  requiredAction?: string; // CISA KEV required action
}

export interface Advisory {
  id: string;           // GHSA ID
  source: 'github';
  severity: string;      // LOW, MODERATE, HIGH, CRITICAL
  summary: string;
  description?: string;
  published: string;     // ISO 8601 date string
  modified?: string;      // ISO 8601 date string
  cveId?: string;       // Associated CVE ID
  references?: string[];
  affectedPackages?: string[]; // For package-level advisories
  vulnerableVersions?: string[];
  patchedVersions?: string[];
}

export interface SecuritySearchResult {
  results: SecurityDatabaseResults;
  totalDatabases: number;
  totalVulnerabilities: number;
  duration: number;
}

export interface SecurityDatabaseResults {
  nvd?: NVDResult;
  cisa_kev?: CisaKevResult;
  github?: GitHubResult;
  osv?: OSVResult;
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

export interface SecuritySearchParams {
  databases: string[];
  terms: string[];
  severity?: string;
  maxResults?: number;
  includeExploited?: boolean;
  ecosystem?: string;
  githubRepo?: string;
}
