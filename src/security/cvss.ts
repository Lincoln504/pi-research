/**
 * Minimal CVSS v3.0/v3.1 base-score calculator.
 *
 * Used to derive a qualitative severity + numeric base score from a CVSS vector STRING (OSV
 * `severity[]` entries carry a vector, not a number). Implements the official base-score equations
 * for both versions. The two are identical EXCEPT the changed-scope impact sub-score, which v3.1
 * revised (`(iss·0.9731 − 0.02)^13` vs v3.0's `(iss − 0.02)^15`); using the wrong one on a
 * changed-scope vector can cross a severity band (e.g. 6.9/MEDIUM vs 7.0/HIGH), so the formula is
 * selected from the version in the vector prefix. Returns null for a vector it cannot parse, a
 * non-v3 vector, or an incomplete base vector — callers then fall back to UNKNOWN rather than guess.
 *
 * Only the BASE metric group is computed (temporal/environmental are ignored), which is what a
 * severity label reflects. Verified against the CVSS v3.1 specification examples (9.8, 7.8, 6.1, 5.9)
 * and the v3.1 changed-scope case (7.0/HIGH).
 */

const AV: Readonly<Record<string, number>> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Readonly<Record<string, number>> = { L: 0.77, H: 0.44 };
const UI: Readonly<Record<string, number>> = { N: 0.85, R: 0.62 };
// Privileges Required weight depends on Scope (higher when the attack crosses a scope boundary).
const PR_UNCHANGED: Readonly<Record<string, number>> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Readonly<Record<string, number>> = { N: 0.85, L: 0.68, H: 0.5 };
const IMPACT: Readonly<Record<string, number>> = { H: 0.56, L: 0.22, N: 0 };

/** CVSS v3.1 Roundup: the smallest number to one decimal place that is >= input (float-safe). */
function roundUp1(input: number): number {
  const intInput = Math.round(input * 100000);
  if (intInput % 10000 === 0) return intInput / 100000;
  return (Math.floor(intInput / 10000) + 1) / 10;
}

/** Map a CVSS base score (0.0–10.0) to its qualitative severity rating (CVSS v3 bands). */
export function severityFromScore(score: number): string {
  if (score <= 0) return 'NONE';
  if (score < 4.0) return 'LOW';
  if (score < 7.0) return 'MEDIUM';
  if (score < 9.0) return 'HIGH';
  return 'CRITICAL';
}

/**
 * Compute the CVSS v3.0/v3.1 base score + severity from a vector string, or null if it is not a
 * parseable, complete v3 base vector.
 */
export function scoreCvss3(vector: string): { score: number; severity: string } | null {
  const versionMatch = typeof vector === 'string' ? /^CVSS:3\.([01])\//i.exec(vector) : null;
  if (!versionMatch) return null;
  const isV31 = versionMatch[1] === '1';

  const metrics: Record<string, string> = {};
  for (const part of vector.split('/').slice(1)) {
    const [k, v] = part.split(':');
    if (k && v) metrics[k.toUpperCase()] = v.toUpperCase();
  }

  const scope = metrics['S'];
  const av = AV[metrics['AV'] ?? ''];
  const ac = AC[metrics['AC'] ?? ''];
  const ui = UI[metrics['UI'] ?? ''];
  const pr = (scope === 'C' ? PR_CHANGED : PR_UNCHANGED)[metrics['PR'] ?? ''];
  const c = IMPACT[metrics['C'] ?? ''];
  const i = IMPACT[metrics['I'] ?? ''];
  const a = IMPACT[metrics['A'] ?? ''];

  if ((scope !== 'U' && scope !== 'C') || [av, ac, ui, pr, c, i, a].some(x => x === undefined)) {
    return null; // incomplete / invalid base vector
  }

  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  // Changed-scope impact differs between versions; base and unchanged-scope impact are identical.
  const impact = scope === 'U'
    ? 6.42 * iss
    : isV31
      ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss * 0.9731 - 0.02, 13)
      : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * av! * ac! * pr! * ui!;

  let score: number;
  if (impact <= 0) {
    score = 0;
  } else if (scope === 'U') {
    score = roundUp1(Math.min(impact + exploitability, 10));
  } else {
    score = roundUp1(Math.min(1.08 * (impact + exploitability), 10));
  }

  return { score, severity: severityFromScore(score) };
}
