/**
 * OSV (Open Source Vulnerabilities) API Types
 */

import type { Vulnerability } from './types.ts';
import { scoreCvss3 } from './cvss.ts';

/**
 * OSV API vulnerability response (from GET /vulns/{id})
 */
export interface OsvVulnerability {
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
export interface OsvSeverity {
  type: string;
  score: string;
}

/**
 * OSV database-specific metadata
 */
export interface OsvDatabaseSpecific {
  severity?: string;
  cwe?: Array<{ id: string } | string>;
  [key: string]: unknown;
}

/**
 * OSV affected package entry
 */
export interface OsvAffected {
  package?: OsvPackage;
  ranges?: OsvRange[];
  versions?: string[];
  database_specific?: Record<string, unknown>;
  severity?: OsvSeverity[];
}

/**
 * OSV package information
 */
export interface OsvPackage {
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
export interface OsvRange {
  type: string;
  repo?: string;
  events: OsvRangeEvent[];
  database_specific?: Record<string, unknown>;
}

/**
 * OSV range event (introduced, fixed, last_affected, limits)
 */
export interface OsvRangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

/**
 * OSV reference entry
 */
export interface OsvReference {
  type?: string;
  url?: string;
}

/**
 * OSV query request body
 */
export interface OsvQueryRequest {
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
export interface OsvQueryResponse {
  vulns?: OsvVulnerability[];
  [key: string]: unknown;
}

// Type guards
export function isOsvVulnerability(value: unknown): value is OsvVulnerability {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj['id'] === 'string';
}

export function isOsvQueryResponse(value: unknown): value is OsvQueryResponse {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj['vulns']);
}

// Helper Functions
export function mapOsvItemToVulnerability(item: OsvVulnerability): Vulnerability {
  const osvId: string = item.id;
  const summary: string = item.summary ?? item.details ?? '';
  const details: string = item.details ?? '';
  const published: string | undefined = item.published;
  const modified: string = item.modified ?? '';

  let severityStr: string | undefined;
  if (item.database_specific !== undefined &&
      typeof item.database_specific.severity === 'string') {
    severityStr = item.database_specific.severity;
  }
  let severity: string = mapOsvSeverity(severityStr);

  // When OSV has no database_specific.severity (non-GHSA records: CVE/PyPA/Go/RustSec), the only
  // severity signal is a CVSS vector in item.severity[]. Compute the v3 base score/severity from it
  // rather than reporting UNKNOWN with no score.
  let cvssScore: number | undefined;
  let cvssVector: string | undefined;
  if (severity === 'UNKNOWN' && Array.isArray(item.severity)) {
    for (const sev of item.severity) {
      if (sev && typeof sev.score === 'string' && /^CVSS_V3/i.test(sev.type ?? '')) {
        const scored = scoreCvss3(sev.score);
        if (scored) {
          severity = scored.severity === 'NONE' ? 'UNKNOWN' : scored.severity;
          cvssScore = scored.score;
          cvssVector = sev.score;
          break;
        }
      }
    }
  }

  const aliases: string[] = item.aliases ?? [];
  const references: string[] = [...aliases];

  if (item.references !== undefined) {
    for (const ref of item.references) {
      if (ref.url !== undefined && ref.url !== '') {
        references.push(ref.url);
      }
    }
  }

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

        if (affectedEntry.ranges !== undefined) {
          for (const range of affectedEntry.ranges) {
            // Guard against a malformed range missing `events` (upstream validation only
            // checks the vuln `id`): an unguarded events.find() would throw a TypeError,
            // fail the whole term in Promise.allSettled, and discard all its vulns.
            const events: OsvRangeEvent[] = Array.isArray(range.events) ? range.events : [];

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

  const cwes: string[] = [];
  if (item.database_specific !== undefined) {
    if (item.database_specific.cwe !== undefined && Array.isArray(item.database_specific.cwe)) {
      for (const cwe of item.database_specific.cwe) {
        if (typeof cwe === 'string') {
          cwes.push(cwe);
        } else if (typeof cwe === 'object' && cwe !== null && typeof (cwe as { id?: string }).id === 'string') {
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
    cvssScore,
    cvssVector,
    cwes,
    references,
    affectedProducts,
    fixes,
    knownExploited: false,
  };
}

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