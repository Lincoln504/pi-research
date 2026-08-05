/**
 * Host (pi) version compatibility policy.
 *
 * The declared dependency range cannot enforce this: as a pi extension the HOST
 * supplies `@earendil-works/*`, so our package.json never constrains it; and
 * standalone, published tarballs carry no lockfile, so a fresh install resolves
 * the newest 0.x at that instant. pi is pre-1.0, where a minor bump may break
 * anything under semver — and 0.83.0 already did extend the ResourceLoader
 * contract. So: hard floor, soft tested-ceiling.
 */

import { describe, it, expect } from 'vitest';
import {
  parsePiVersion,
  compareVersions,
  checkPiCompatibility,
  PI_MIN_VERSION,
  PI_TESTED_MAX_VERSION,
} from '../../../src/core/pi-version.ts';

describe('parsePiVersion', () => {
  it.each([
    ['0.83.0', { major: 0, minor: 83, patch: 0 }],
    ['v0.83.0', { major: 0, minor: 83, patch: 0 }],
    ['1.2.3', { major: 1, minor: 2, patch: 3 }],
    // pi has shipped pre-release and build-metadata suffixes; the numeric core is
    // what matters, and refusing these would hard-fail a working host. The
    // pre-release flag is carried so the FLOOR comparison can order 0.80.8-rc.1
    // below 0.80.8; build metadata does not affect ordering and carries none.
    ['0.84.0-rc.1', { major: 0, minor: 84, patch: 0, prerelease: true }],
    ['0.84.0+build.5', { major: 0, minor: 84, patch: 0 }],
    ['  0.81.2  ', { major: 0, minor: 81, patch: 2 }],
  ])('parses %s', (input, expected) => {
    expect(parsePiVersion(input)).toEqual(expected);
  });

  it.each([[''], ['not-a-version'], ['0.83'], ['x.y.z']])(
    'returns null for unparseable input %s (never a silently-wrong comparison)',
    (input) => {
      expect(parsePiVersion(input)).toBeNull();
    },
  );

  it('does not throw on null/undefined input', () => {
    expect(parsePiVersion(undefined as unknown as string)).toBeNull();
    expect(parsePiVersion(null as unknown as string)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });
    expect(compareVersions(v(0, 80, 8), v(0, 80, 8))).toBe(0);
    expect(compareVersions(v(0, 80, 7), v(0, 80, 8))).toBeLessThan(0);
    expect(compareVersions(v(0, 80, 9), v(0, 80, 8))).toBeGreaterThan(0);
    expect(compareVersions(v(0, 79, 99), v(0, 80, 0))).toBeLessThan(0);
    expect(compareVersions(v(1, 0, 0), v(0, 99, 99))).toBeGreaterThan(0);
  });
});

describe('checkPiCompatibility', () => {
  it('rejects a version below the floor as fatal', () => {
    const r = checkPiCompatibility('0.80.7');
    expect(r.level).toBe('too-old');
    expect(r.fatal).toBe(true);
    expect(r.message).toMatch(/too old/i);
    expect(r.message).toContain('0.80.8');
  });

  it('accepts exactly the floor', () => {
    const r = checkPiCompatibility('0.80.8');
    expect(r.level).toBe('ok');
    expect(r.fatal).toBe(false);
    expect(r.message).toBeNull();
  });

  it('rejects a PRE-RELEASE of the floor version — semver orders it below the floor', () => {
    // 0.80.8-rc.1 predates 0.80.8 and may lack the very APIs the floor guards
    // (ModelRuntime landed IN 0.80.8). Discarding the tag let it pass as ok.
    const r = checkPiCompatibility('0.80.8-rc.1');
    expect(r.level).toBe('too-old');
    expect(r.fatal).toBe(true);
  });

  it('accepts a pre-release ABOVE the floor inside the tested window', () => {
    const r = checkPiCompatibility('0.81.0-beta.1');
    expect(r.level).toBe('ok');
  });

  it('rejects an unparseable version as fatal rather than guessing', () => {
    const r = checkPiCompatibility('garbage');
    expect(r.level).toBe('unparseable');
    expect(r.fatal).toBe(true);
  });

  it('accepts the tested ceiling silently', () => {
    const { major, minor } = PI_TESTED_MAX_VERSION;
    const r = checkPiCompatibility(`${major}.${minor}.0`);
    expect(r.level).toBe('ok');
    expect(r.message).toBeNull();
  });

  it('accepts a PATCH above the tested ceiling silently — a patch is not a new surface', () => {
    const { major, minor } = PI_TESTED_MAX_VERSION;
    const r = checkPiCompatibility(`${major}.${minor}.99`);
    expect(r.level).toBe('ok');
    expect(r.message).toBeNull();
  });

  it('warns — but does NOT reject — a newer MINOR than was tested', () => {
    // Refusing here would strand every user on each pi release; staying silent
    // would hide the single most likely cause of a weird failure.
    const { major, minor } = PI_TESTED_MAX_VERSION;
    const r = checkPiCompatibility(`${major}.${minor + 1}.0`);
    expect(r.level).toBe('untested');
    expect(r.fatal).toBe(false);
    expect(r.message).toMatch(/newer than the last version/i);
  });

  it('warns on a newer MAJOR too', () => {
    const r = checkPiCompatibility(`${PI_TESTED_MAX_VERSION.major + 1}.0.0`);
    expect(r.level).toBe('untested');
    expect(r.fatal).toBe(false);
  });

  it('honours injected thresholds so the policy is testable independent of the constants', () => {
    const min = { major: 1, minor: 0, patch: 0 };
    const testedMax = { major: 2, minor: 0, patch: 0 };
    expect(checkPiCompatibility('0.9.9', { min, testedMax }).level).toBe('too-old');
    expect(checkPiCompatibility('1.5.0', { min, testedMax }).level).toBe('ok');
    expect(checkPiCompatibility('2.1.0', { min, testedMax }).level).toBe('untested');
  });

  it('keeps the floor at or below the tested ceiling (constants sanity)', () => {
    expect(compareVersions(PI_MIN_VERSION, PI_TESTED_MAX_VERSION)).toBeLessThanOrEqual(0);
  });

  it('agrees with the range declared in package.json', async () => {
    // A floor that drifts from the declared range means npm resolves a version the
    // runtime check then rejects — an install that "succeeds" and cannot run.
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    const range: string = pkg.dependencies['@earendil-works/pi-coding-agent'];
    const declaredFloor = /^>=\s*(\d+\.\d+\.\d+)/.exec(range)?.[1];
    expect(declaredFloor).toBeDefined();
    expect(parsePiVersion(declaredFloor!)).toEqual(PI_MIN_VERSION);
  });

  it('has actually been tested against the installed pi version', async () => {
    // Guards the constant against silently going stale: if the repo has upgraded
    // pi past the tested ceiling, either the upgrade was verified (bump the
    // constant) or it was not (this is the reminder).
    const { readFileSync } = await import('node:fs');
    const installed = JSON.parse(
      readFileSync(new URL('../../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8'),
    ).version as string;
    const r = checkPiCompatibility(installed);
    expect(r.fatal).toBe(false);
    expect(r.level).toBe('ok');
  });
});
