/**
 * NVD (National Vulnerability Database) API Types
 */

export interface CVSSData {
  readonly version?: string;
  readonly vectorString?: string;
  readonly baseScore?: number;
  readonly baseSeverity?: string;
}

export interface CVSSMetricV31 {
  readonly cvssData: CVSSData;
}

export interface CVSSMetricV30 {
  readonly cvssData: CVSSData;
}

export interface WeaknessDescription {
  readonly value?: string;
}

export interface Weakness {
  readonly description?: WeaknessDescription[];
}

export interface Reference {
  readonly url?: string;
}

export interface CPEMatch {
  readonly criteria?: string;
}

export interface Node {
  readonly cpeMatch?: CPEMatch[];
}

export interface Configuration {
  readonly nodes?: Node[];
}

export interface Description {
  readonly value?: string;
}

// CVSS v4.0 mirrors v3 (score + qualitative severity live in cvssData). NVD is actively adding it.
export interface CVSSMetricV40 {
  readonly cvssData: CVSSData;
}

// CVSS v2 differs: cvssData carries the numeric baseScore/vectorString but NO qualitative rating —
// NVD exposes the v2 baseSeverity (LOW/MEDIUM/HIGH) at the METRIC level instead.
export interface CVSSMetricV2 {
  readonly cvssData: CVSSData;
  readonly baseSeverity?: string;
}

export interface Metrics {
  readonly cvssMetricV40?: CVSSMetricV40[];
  readonly cvssMetricV31?: CVSSMetricV31[];
  readonly cvssMetricV30?: CVSSMetricV30[];
  readonly cvssMetricV2?: CVSSMetricV2[];
}

export interface CVE {
  readonly id?: string;
  readonly descriptions?: Description[];
  readonly published?: string;
  readonly lastModified?: string;
  readonly metrics?: Metrics;
  readonly weaknesses?: Weakness[];
  readonly references?: Reference[];
  readonly configurations?: Configuration[];
}

export interface NVDEntry {
  readonly cve: CVE;
}

export interface NVDApiResponse {
  readonly vulnerabilities?: NVDEntry[];
}

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SearchOptions {
  readonly severity?: Severity;
  readonly maxResults?: number;
  readonly includeExploited?: boolean;
  readonly cweId?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly maxPages?: number;
  // Caller cancellation; composed with the per-request timeout and used to
  // short-circuit the rate-limit spacing, pagination, and retry backoff.
  readonly signal?: AbortSignal;
}

export interface RetryOptions {
  readonly maxRetries: number;
  readonly initialDelay: number;
  readonly maxDelay: number;
  readonly signal?: AbortSignal;
}

// Type guards
export function isWeaknessDescription(value: unknown): value is WeaknessDescription {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value
  );
}

export function isWeakness(value: unknown): value is Weakness {
  return (
    typeof value === 'object' &&
    value !== null &&
    'description' in value
  );
}

export function isReference(value: unknown): value is Reference {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value
  );
}

export function isCPEMatch(value: unknown): value is CPEMatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    'criteria' in value
  );
}

export function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cpeMatch' in value
  );
}

export function isConfiguration(value: unknown): value is Configuration {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodes' in value
  );
}

export function isDescription(value: unknown): value is Description {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value
  );
}

export function isNVDEntry(value: unknown): value is NVDEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cve' in value
  );
}

export function isNVDApiResponse(value: unknown): value is NVDApiResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'vulnerabilities' in value
  );
}