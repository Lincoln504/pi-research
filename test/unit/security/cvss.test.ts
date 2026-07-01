import { describe, it, expect } from 'vitest';
import { scoreCvss3, severityFromScore } from '../../../src/security/cvss.ts';

describe('scoreCvss3 — CVSS v3.1 base-score calculator', () => {
  // Official CVSS v3.1 specification / well-known reference vectors.
  const cases: Array<{ vector: string; score: number; severity: string }> = [
    { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', score: 9.8, severity: 'CRITICAL' },
    { vector: 'CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', score: 7.8, severity: 'HIGH' },
    { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', score: 6.1, severity: 'MEDIUM' }, // scope-changed
    { vector: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H', score: 5.9, severity: 'MEDIUM' },
    { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', score: 0, severity: 'NONE' },
  ];

  for (const { vector, score, severity } of cases) {
    it(`scores ${vector} → ${score} (${severity})`, () => {
      const result = scoreCvss3(vector);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(score);
      expect(result!.severity).toBe(severity);
    });
  }

  it('accepts CVSS:3.0 vectors (same base formula for unchanged scope)', () => {
    expect(scoreCvss3('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')?.score).toBe(9.8);
  });

  it('uses the version-specific changed-scope impact equation (v3.1 revised it)', () => {
    // Same vector, different version: v3.1's changed-scope impact formula yields a higher score
    // that crosses the MEDIUM/HIGH band. Using v3.0's formula for a v3.1 vector under-reports it.
    const vector = 'AV:P/AC:H/PR:H/UI:N/S:C/C:H/I:H/A:H';
    expect(scoreCvss3(`CVSS:3.1/${vector}`)).toEqual({ score: 7.0, severity: 'HIGH' });
    expect(scoreCvss3(`CVSS:3.0/${vector}`)).toEqual({ score: 6.9, severity: 'MEDIUM' });
  });

  it('returns null for non-v3, unparseable, or incomplete vectors', () => {
    expect(scoreCvss3('CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P')).toBeNull(); // v2
    expect(scoreCvss3('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull(); // v4
    expect(scoreCvss3('not a vector')).toBeNull();
    expect(scoreCvss3('CVSS:3.1/AV:N/AC:L')).toBeNull(); // incomplete base
  });

  it('maps scores to CVSS v3 severity bands', () => {
    expect(severityFromScore(0)).toBe('NONE');
    expect(severityFromScore(3.9)).toBe('LOW');
    expect(severityFromScore(4.0)).toBe('MEDIUM');
    expect(severityFromScore(6.9)).toBe('MEDIUM');
    expect(severityFromScore(7.0)).toBe('HIGH');
    expect(severityFromScore(9.0)).toBe('CRITICAL');
    expect(severityFromScore(10)).toBe('CRITICAL');
  });
});
