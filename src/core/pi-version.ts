/**
 * Host (pi) version compatibility.
 *
 * Extracted from the extension entry point so the policy is one testable unit
 * rather than inline arithmetic, because the range this package declares cannot
 * itself enforce compatibility:
 *
 *   - As a pi EXTENSION, the host supplies `@earendil-works/*`. Our package.json
 *     range never constrains it, so an in-process check is the only enforcement.
 *   - As a standalone CLI/SDK, the range is `>=0.80.8 <1` and published tarballs
 *     carry no lockfile, so every fresh install resolves the newest 0.x at that
 *     instant. pi is pre-1.0: a minor bump may break anything under semver, and
 *     already has (0.83.0 extended the ResourceLoader contract).
 *
 * Hence two thresholds, not one. Below the FLOOR we throw — those APIs are gone
 * and nothing will work. Above the TESTED ceiling we warn once and continue: a
 * newer pi usually works, refusing it would strand users on every pi release, but
 * silently pretending it is verified is how "works on my machine" ships.
 */

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a semver-ish version string. Tolerates a `v` prefix and pre-release /
 * build metadata suffixes (`0.84.0-rc.1`, `0.84.0+abc`), which pi has used.
 * Returns null when the numeric core cannot be read, so callers degrade to an
 * explicit "cannot determine" rather than to a silently wrong comparison.
 */
export function parsePiVersion(version: string): SemverParts | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if ([major, minor, patch].some((n) => !Number.isFinite(n))) return null;
  return { major, minor, patch };
}

/** Ordering comparison: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: SemverParts, b: SemverParts): number {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

/**
 * Oldest host this package works against.
 *
 * 0.80.8 introduced `ModelRuntime` and removed `AuthStorage` /
 * `ModelRegistry.create()`. `buildModelRegistry` calls `ModelRuntime.create()`
 * unconditionally, and `createAgentSession()` is invoked without the removed
 * `modelRegistry` option, relying on the 0.80.8+ host to build its own.
 */
export const PI_MIN_VERSION: SemverParts = { major: 0, minor: 80, patch: 8 };

/**
 * Newest host line this release was actually exercised against (CI + a real run).
 * Bump this — deliberately — when a new pi is verified, not automatically.
 * Compared on MAJOR.MINOR only: a patch bump within a tested line is not a new
 * surface, and warning on it would be noise.
 */
export const PI_TESTED_MAX_VERSION: SemverParts = { major: 0, minor: 83, patch: 0 };

export type PiCompatibilityLevel = 'ok' | 'unparseable' | 'too-old' | 'untested';

export interface PiCompatibility {
  level: PiCompatibilityLevel;
  /** True when the host must be rejected outright. */
  fatal: boolean;
  message: string | null;
}

/**
 * Classify a host version against the supported window.
 *
 * Pure: no logging, no throwing. The caller decides what to do with each level,
 * which is what makes the policy testable without stubbing a logger.
 */
export function checkPiCompatibility(
  version: string,
  opts: { min?: SemverParts; testedMax?: SemverParts } = {},
): PiCompatibility {
  const min = opts.min ?? PI_MIN_VERSION;
  const testedMax = opts.testedMax ?? PI_TESTED_MAX_VERSION;

  const parsed = parsePiVersion(version);
  if (!parsed) {
    return {
      level: 'unparseable',
      fatal: true,
      message:
        `[pi-research] Cannot parse pi-coding-agent version "${version}". ` +
        `Please ensure pi-coding-agent is installed correctly.`,
    };
  }

  if (compareVersions(parsed, min) < 0) {
    return {
      level: 'too-old',
      fatal: true,
      message:
        `[pi-research] pi-coding-agent v${version} is too old. ` +
        `Requires v${min.major}.${min.minor}.${min.patch}+. Please update pi-coding-agent.`,
    };
  }

  // Compare on major.minor only — a patch release inside a tested line is fine.
  const line: SemverParts = { major: parsed.major, minor: parsed.minor, patch: 0 };
  const testedLine: SemverParts = { major: testedMax.major, minor: testedMax.minor, patch: 0 };
  if (compareVersions(line, testedLine) > 0) {
    return {
      level: 'untested',
      fatal: false,
      message:
        `[pi-research] pi-coding-agent v${version} is newer than the last version this ` +
        `release of pi-research was tested against (v${testedMax.major}.${testedMax.minor}.x). ` +
        `Continuing — it will most likely work — but if you hit anything odd, that mismatch ` +
        `is the first thing to suspect. Updating pi-research usually resolves it.`,
    };
  }

  return { level: 'ok', fatal: false, message: null };
}
