/**
 * CISA Known Exploited Vulnerabilities (KEV) Catalog Client
 *
 * CISA KEV Catalog - actively exploited vulnerabilities
 * JSON feed: https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
 * Free public feed, no authentication required
 */

import type { Vulnerability, CisaKevResult } from './types.ts';
import { createTimeoutSignal } from '../web-research/retry-utils.ts';

const CISA_KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

// ============================================================================
// Type Definitions for CISA KEV API
// ============================================================================

/**
 * CISA KEV Catalog Item structure from the official API
 */
interface CisaKevItem {
  readonly cveID?: string;
  readonly cve_id?: string;
  readonly id?: string;
  readonly vendorProject?: string;
  readonly vendor?: string;
  readonly product?: string;
  readonly vulnerabilityName?: string;
  readonly shortDescription?: string;
  readonly description?: string;
  readonly dateAdded?: string;
  readonly addedDate?: string;
  readonly dueDate?: string;
  readonly requiredAction?: string;
  readonly action?: string;
}

/**
 * CISA KEV API Response structure
 */
interface CisaKevResponse {
  readonly vulnerabilities?: readonly CisaKevItem[];
  readonly title?: string;
  readonly catalogVersion?: string;
  readonly dateReleased?: string;
}

/**
 * Type guard to check if value is a valid CisaKevItem
 */
function isCisaKevItem(value: unknown): value is CisaKevItem {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    typeof item['cveID'] === 'string' ||
    typeof item['cve_id'] === 'string' ||
    typeof item['id'] === 'string'
  );
}

/**
 * Type guard to check if value is an array of CisaKevItem
 */
function isCisaKevItemArray(value: unknown): value is readonly CisaKevItem[] {
  return Array.isArray(value) && value.every(isCisaKevItem);
}

/**
 * Type guard to check if value is a CisaKevResponse
 */
function isCisaKevResponse(value: unknown): value is CisaKevResponse {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const response = value as Record<string, unknown>;
  return (
    typeof response === 'object' &&
    (response['vulnerabilities'] === undefined || Array.isArray(response['vulnerabilities']))
  );
}

/**
 * Extract CISA KEV items from various possible response formats
 */
function extractCisaKevItems(data: unknown): readonly CisaKevItem[] {
  if (isCisaKevItemArray(data)) {
    return data;
  }

  if (isCisaKevResponse(data) && data.vulnerabilities) {
    return data.vulnerabilities.filter(isCisaKevItem);
  }

  return [];
}

// ============================================================================
// Main API Functions
// ============================================================================

/**
 * Fetch and search CISA KEV catalog
 *
 * @param terms - CVE IDs to search for (optional)
 * @param options - Optional filters
 * @returns Promise resolving to CISA KEV search results
 */
export async function searchCisaKev(
  terms: string[] = [],
  options?: {
    readonly vendor?: string;
    readonly product?: string;
    readonly maxResults?: number;
  },
): Promise<CisaKevResult> {
  const maxResults = options?.maxResults ?? 100;
  const vulnerabilities: Vulnerability[] = [];
  let error: string | undefined = undefined;

  try {
    const response: Response = await fetch(CISA_KEV_URL, {
      headers: {
        'User-Agent': 'pi-research/2.0',
        'Accept': 'application/json',
      },
      signal: createTimeoutSignal(30000), // 30s timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: unknown = await response.json();

    // CISA KEV format is an array of vulnerability objects or nested in a response object
    const cisaData = extractCisaKevItems(data);

    // Map CISA format to our Vulnerability interface
    for (const item of cisaData) {
      const vuln: Vulnerability = mapCisaItemToVulnerability(item);

      // Filter by search terms if provided
      if (terms.length > 0 && !terms.some((term: string): boolean =>
        vuln.id.toLowerCase().includes(term.toLowerCase()) ||
        vuln.description.toLowerCase().includes(term.toLowerCase()),
      )) {
        continue;
      }

      // Filter by vendor/product if provided
      if (options?.vendor !== undefined) {
        const vendorLower = vuln.vendor?.toLowerCase() ?? '';
        if (!vendorLower.includes(options.vendor.toLowerCase())) {
          continue;
        }
      }

      if (options?.product !== undefined) {
        const productLower = vuln.product?.toLowerCase() ?? '';
        if (!productLower.includes(options.product.toLowerCase())) {
          continue;
        }
      }

      vulnerabilities.push(vuln);
    }

    // Sort by due date (most urgent first)
    vulnerabilities.sort((a: Vulnerability, b: Vulnerability): number => {
      if (a.dueDate === undefined) {
        return 1;
      }
      if (b.dueDate === undefined) {
        return -1;
      }
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    });

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
 * Safely extract a string property from an unknown object
 */
function safeString(value: unknown, defaultValue: string = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  return defaultValue;
}

/**
 * Map CISA KEV item to Vulnerability interface
 *
 * @param item - CISA KEV item from API
 * @returns Mapped Vulnerability object
 */
function mapCisaItemToVulnerability(item: CisaKevItem): Vulnerability {
  // CISA KEV format (example based on scraped structure)
  const cveId: string = [item.cveID, item.cve_id, item.id].map(v => safeString(v)).find(s => s.length > 0) ?? '';
  const vendor: string = [item.vendorProject, item.vendor].map(v => safeString(v)).find(s => s.length > 0) ?? '';
  const product: string = [item.product, item.vulnerabilityName].map(v => safeString(v)).find(s => s.length > 0) ?? '';
  const description: string = [item.shortDescription, item.description].map(v => safeString(v)).find(s => s.length > 0) ?? '';
  const dateAdded: string = [item.dateAdded, item.addedDate].map(v => safeString(v)).find(s => s.length > 0) ?? '';
  const dueDate: string = safeString(item.dueDate);
  const requiredAction: string = [item.requiredAction, item.action].map(v => safeString(v)).find(s => s.length > 0) ?? '';

  const affectedProducts: string[] = [vendor, product].filter(
    (value: string): boolean => value.length > 0,
  );

  return {
    id: cveId,
    source: 'cisa_kev',
    severity: 'CRITICAL', // All KEV entries are critical priority
    description,
    published: dateAdded.length > 0 ? dateAdded : undefined,
    modified: dateAdded.length > 0 ? dateAdded : undefined,
    cvssScore: undefined, // CISA doesn't include CVSS score
    cwes: [],
    references: [],
    affectedProducts,
    fixes: [],
    vendor: vendor.length > 0 ? vendor : undefined,
    product: product.length > 0 ? product : undefined,
    knownExploited: true,
    dueDate: dueDate.length > 0 ? dueDate : undefined,
    requiredAction: requiredAction.length > 0 ? requiredAction : undefined,
  };
}
