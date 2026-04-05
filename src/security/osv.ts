/**
 * OSV (Open Source Vulnerabilities) API Client
 *
 * Open Source Vulnerabilities
 * API: https://api.osv.dev/v1/
 * Free public API, no authentication required
 */

import type { Vulnerability, OSVResult } from './types.ts';
import { createTimeoutSignal } from '../web-research/retry-utils.ts';
import { logger } from '../logger.ts';

const OSV_BASE_URL = 'https://api.osv.dev/v1';
const DEFAULT_MAX_RESULTS = 20;

// ==================== OSV API Type Definitions ====================

/**
 * OSV API vulnerability response (from GET /vulns/{id})
 */
interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  published?: string;
  modified?: string;
  withdrawn?: string;
  aliases?: string[];
  related?: string[];
  affected?: OsvAffected[];
  severity?: OsvSeverity[];
  references?: OsvReference[];
  database_specific?: OsvDatabaseSpecific;
}

/**
 * OSV severity entry
 */
interface OsvSeverity {
  type: string;
  score: string;
}

/**
 * OSV database-specific metadata
 */
interface OsvDatabaseSpecific {
  severity?: string;
  cwe?: Array<{ id: string } | string>;
  [key: string]: unknown;
}

/**
 * OSV affected package entry
 */
interface OsvAffected {
  package?: OsvPackage;
  ranges?: OsvRange[];
  versions?: string[];
  database_specific?: Record<string, unknown>;
  severity?: OsvSeverity[];
}

/**
 * OSV package information
 */
interface OsvPackage {
  name?: string;
  ecosystem?: string;
  purl?: string;
  ecosystem_specific?: {
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * OSV version range information
 */
interface OsvRange {
  type: string;
  repo?: string;
  events: OsvRangeEvent[];
  database_specific?: Record<string, unknown>;
}

/**
 * OSV range event (introduced, fixed, last_affected, limits)
 */
interface OsvRangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

/**
 * OSV reference entry
 */
interface OsvReference {
  type?: string;
  url?: string;
}

/**
 * OSV query request body
 */
interface OsvQueryRequest {
  package: {
    name: string;
    ecosystem: string;
    purl?: string;
  };
  version?: string;
  commit?: string;
}

/**
 * OSV query response (from POST /query)
 */
interface OsvQueryResponse {
  vulns?: OsvVulnerability[];
  [key: string]: unknown;
}

/**
 * Type guard to check if value is an OsvVulnerability
 */
function isOsvVulnerability(value: unknown): value is OsvVulnerability {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj['id'] === 'string';
}

/**
 * Type guard to check if value is an OsvQueryResponse
 */
function isOsvQueryResponse(value: unknown): value is OsvQueryResponse {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj['vulns']);
}

// ==================== API Functions ====================

/**
 * Search OSV for vulnerabilities
 *
 * @param terms - Package names, CVE IDs, or keywords
 * @param options - Optional filters
 * @returns OSV search result with vulnerabilities and optional error
 */
export async function searchOSV(
  terms: string[],
  options?: {
    ecosystem?: string;      // npm, PyPI, Maven, Go, Rust, etc.
    severity?: string;       // LOW, MODERATE, HIGH, CRITICAL
    maxResults?: number;
    includeAffected?: boolean; // Include affected version ranges
  },
): Promise<OSVResult> {
  const maxResults: number = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const vulnerabilities: Vulnerability[] = [];
  let error: string | undefined = undefined;

  try {
    const allVulns: Vulnerability[] = [];
    let skippedNoEcosystem = 0;

    for (const term of terms) {
      let response: Response;

      // OSV API: GET /vulns/{id} for CVE/OSV/GHSA IDs, POST /query for package names
      const termUpper: string = term.toUpperCase();
      if (termUpper.startsWith('CVE-') || termUpper.startsWith('GHSA-') || termUpper.startsWith('OSV-')) {
        // GHSA IDs: OSV requires uppercase prefix + lowercase hex portions.
        // Normalize regardless of how the caller typed it.
        const normalizedId: string = termUpper.startsWith('GHSA-')
          ? `GHSA-${term.slice(term.indexOf('-') + 1).toLowerCase()}`
          : termUpper;
        const url: string = `${OSV_BASE_URL}/vulns/${encodeURIComponent(normalizedId)}`;
        response = await fetch(url, {
          headers: { 'User-Agent': 'pi-research/2.0', 'Accept': 'application/json' },
          signal: createTimeoutSignal(30000),
        });
      } else {
        // POST /query requires package.name + package.ecosystem.
        // Sending name without ecosystem always returns HTTP 400 "Invalid query."
        if (options?.ecosystem === undefined || options.ecosystem === '') {
          skippedNoEcosystem++;
          continue;
        }
        const body: OsvQueryRequest = { package: { name: term, ecosystem: options.ecosystem } };
        response = await fetch(`${OSV_BASE_URL}/query`, {
          method: 'POST',
          headers: {
            'User-Agent': 'pi-research/2.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: createTimeoutSignal(30000),
        });
      }

      if (!response.ok) {
        logger.warn(`OSV query failed for "${term}": ${response.status}`);
        continue;
      }

      const data: unknown = await response.json();

      // Single vuln response (GET /vulns/{id}) vs batch response (POST /query)
      let items: OsvVulnerability[];

      if (isOsvVulnerability(data)) {
        items = [data];
      } else if (isOsvQueryResponse(data)) {
        items = data.vulns ?? [];
      } else {
        logger.warn(`OSV returned unexpected format for "${term}"`);
        continue;
      }

      for (const item of items) {
        const vuln: Vulnerability = mapOsvItemToVulnerability(item);

        // Filter by severity if provided
        if (options?.severity !== undefined && options.severity !== '') {
          const severity: string = options.severity.toUpperCase();
          if (vuln.severity !== severity) {
            continue;
          }
        }

        allVulns.push(vuln);
      }
    }

    // Deduplicate by OSV ID
    const uniqueVulns = new Map<string, Vulnerability>();
    for (const vuln of allVulns) {
      if (!uniqueVulns.has(vuln.id)) {
        uniqueVulns.set(vuln.id, vuln);
      }
    }

    vulnerabilities.push(...Array.from(uniqueVulns.values()));

    if (skippedNoEcosystem > 0) {
      error = `${skippedNoEcosystem} term(s) require the ecosystem parameter for OSV package search (e.g., ecosystem: "npm"). CVE/GHSA/OSV IDs work without it.`;
    }

  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    count: vulnerabilities.length,
    vulnerabilities: vulnerabilities.slice(0, maxResults),
    error,
  };
}

/**
 * Get vulnerability by OSV ID
 *
 * @param osvId - OSV vulnerability ID (e.g., CVE-2023-1234, GHSA-abc1-23de-fg45)
 * @returns Vulnerability object if found, null otherwise
 */
export async function getOSVById(osvId: string): Promise<Vulnerability | null> {
  try {
    const url: string = `${OSV_BASE_URL}/vulns/${osvId}`;
    const response: Response = await fetch(url, {
      headers: {
        'User-Agent': 'pi-research/2.0',
        'Accept': 'application/json',
      },
      signal: createTimeoutSignal(30000),
    });

    if (!response.ok) {
      return null;
    }

    const data: unknown = await response.json();

    if (!isOsvVulnerability(data)) {
      logger.error(`OSV ${osvId} returned unexpected format`);
      return null;
    }

    return mapOsvItemToVulnerability(data);
  } catch (err: unknown) {
    logger.error(`Error fetching OSV ${osvId}:`, err);
    return null;
  }
}

// ==================== Helper Functions ====================

/**
 * Map OSV item to Vulnerability interface
 *
 * @param item - OSV vulnerability object
 * @returns Standardized Vulnerability object
 */
function mapOsvItemToVulnerability(item: OsvVulnerability): Vulnerability {
  const osvId: string = item.id;
  const summary: string = item.summary ?? item.details ?? '';
  const details: string = item.details ?? '';
  const published: string | undefined = item.published;
  const modified: string = item.modified ?? '';

  // OSV severity mapping
  // item.severity is an array of {type, score} objects; string severity is in database_specific
  let severityStr: string | undefined;
  if (item.database_specific !== undefined &&
      typeof item.database_specific.severity === 'string') {
    severityStr = item.database_specific.severity;
  }
  const severity: string = mapOsvSeverity(severityStr);

  // Extract aliases (including CVE IDs)
  const aliases: string[] = item.aliases ?? [];
  const references: string[] = [...aliases];

  if (item.references !== undefined) {
    for (const ref of item.references) {
      if (ref.url !== undefined && ref.url !== '') {
        references.push(ref.url);
      }
    }
  }

  // Extract affected packages and versions
  const affectedProducts: string[] = [];
  const fixes: string[] = [];

  if (item.affected !== undefined) {
    for (const affectedEntry of item.affected) {
      const pkg: OsvPackage | undefined = affectedEntry.package;

      if (pkg !== undefined) {
        const pkgName: string = pkg.name ??
                                (pkg.ecosystem_specific !== undefined && typeof pkg.ecosystem_specific.name === 'string'
                                  ? pkg.ecosystem_specific.name
                                  : '');

        if (pkgName !== '') {
          affectedProducts.push(pkgName);
        }

        // Version ranges
        // OSV range format: { type, events: [{introduced: "x"}, {fixed: "y"}] }
        if (affectedEntry.ranges !== undefined) {
          for (const range of affectedEntry.ranges) {
            const events: OsvRangeEvent[] = range.events;

            const introducedEvent: OsvRangeEvent | undefined = events.find(
              (e: OsvRangeEvent) => e.introduced !== undefined,
            );
            const fixedEvent: OsvRangeEvent | undefined = events.find(
              (e: OsvRangeEvent) => e.fixed !== undefined,
            );
            const lastAffectedEvent: OsvRangeEvent | undefined = events.find(
              (e: OsvRangeEvent) => e.last_affected !== undefined,
            );

            const versionInfo: string[] = [];

            if (introducedEvent?.introduced !== undefined) {
              versionInfo.push(`introduced: ${introducedEvent.introduced}`);
            }
            if (fixedEvent?.fixed !== undefined) {
              versionInfo.push(`fixed: ${fixedEvent.fixed}`);
            }
            if (lastAffectedEvent?.last_affected !== undefined) {
              versionInfo.push(`last affected: ${lastAffectedEvent.last_affected}`);
            }

            if (versionInfo.length > 0 && pkgName !== '') {
              fixes.push(`${pkgName}: ${versionInfo.join(', ')}`);
            }
          }
        }
      }
    }
  }

  // Extract CWEs if available
  const cwes: string[] = [];
  if (item.database_specific !== undefined) {
    if (item.database_specific.cwe !== undefined && Array.isArray(item.database_specific.cwe)) {
      for (const cwe of item.database_specific.cwe) {
        if (typeof cwe === 'string') {
          cwes.push(cwe);
        } else if (typeof cwe === 'object' && typeof (cwe as { id?: string }).id === 'string') {
          cwes.push((cwe as { id: string }).id);
        }
      }
    }
  }

  return {
    id: osvId,
    source: 'osv',
    severity,
    description: summary !== '' ? summary : details,
    published,
    modified,
    cvssScore: undefined, // OSV doesn't provide CVSS score
    cvssVector: undefined,
    cwes,
    references,
    affectedProducts,
    fixes,
    knownExploited: false,
  };
}

/**
 * Map OSV severity to standard values
 *
 * @param severity - OSV severity string (e.g., "CRITICAL", "HIGH", "MODERATE", "LOW")
 * @returns Standardized severity value ("CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN")
 */
function mapOsvSeverity(severity?: string): string {
  if (severity === undefined || severity === '') {
    return 'UNKNOWN';
  }

  const upper: string = severity.toUpperCase();

  if (upper === 'CRITICAL') {
    return 'CRITICAL';
  }
  if (upper === 'HIGH') {
    return 'HIGH';
  }
  if (upper === 'MEDIUM' || upper === 'MODERATE') {
    return 'MEDIUM';
  }
  if (upper === 'LOW') {
    return 'LOW';
  }

  return 'UNKNOWN';
}
