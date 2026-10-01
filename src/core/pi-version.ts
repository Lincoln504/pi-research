/**
 * Host (pi) version compatibility.
 *
 * Extracted from the extension entry point so the policy is one testable unit
 * rather than inline arithmetic, because the range this package declares cannot
 * itself enforce compatibility:
 *
 *   - As a pi EXTENSION, the host supplies `@earendil-works/*`. Our package.json
 *     range never constrains it, so an in-process check is the only enforcement.
 *   - As a standalone CLI/SDK, the range is `>=0.99.0 <2` and published tarballs
 *     carry no lockfile, so every fresh install resolves the newest release in
 *     that window at that instant. The host is young: a minor bump may break
 *     anything under semver, and already has (0.83.0 extended the ResourceLoader
 *     contract). The upper bound is `<2` rather than `<1` because 1.0.0 changed
 *     no API this package uses — see the 1.0.0 note on the tested ceiling — and
 *     `<1` would exclude the current release from a fresh install.
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
  /**
   * True when the version carried a pre-release tag (`-rc.1`). Semver orders a
   * pre-release BELOW its release, so `0.80.8-rc.1` predates the `0.80.8` floor
   * and may lack the APIs the floor exists for. Only the floor comparison uses
   * this; the tested-ceiling check compares lines and ignores it.
   */
  prerelease?: boolean;
}

/**
 * Parse a semver-ish version string. Tolerates a `v` prefix and pre-release /
 * build metadata suffixes (`0.84.0-rc.1`, `0.84.0+abc`), which pi has used.
 * Returns null when the numeric core cannot be read, so callers degrade to an
 * explicit "cannot determine" rather than to a silently wrong comparison.
 */
export function parsePiVersion(version: string): SemverParts | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-)?/.exec(String(version ?? '').trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if ([major, minor, patch].some((n) => !Number.isFinite(n))) return null;
  // The flag is emitted only when set, so a plain release parses to the exact
  // {major, minor, patch} shape existing comparisons and tests expect.
  return m[4] === '-' ? { major, minor, patch, prerelease: true } : { major, minor, patch };
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
 *
 * 0.84.0 removed `allowNetwork` from `ModelRuntime.setRuntimeApiKey()`'s own
 * options (`AuthOperationOptions` is now just `{ signal? }`) — but its
 * internal `synchronizeCredentialState()` now hardcodes `refresh({
 * allowNetwork: false, ... })` unconditionally on every call, so
 * `buildModelRegistry`'s explicit-API-key path (model-registry-factory.ts)
 * no longer passes `allowNetwork` at all, RELYING on 0.84.0+'s own
 * unconditional internal guard against a live network catalog connection.
 * On an already-resolved pre-0.84.0 host, `setRuntimeApiKey`'s default
 * (unspecified) network behavior applies instead — reintroducing the
 * indefinite-hang-in-network-restricted-environments bug that explicit
 * option originally existed to prevent. The floor moved to close that gap,
 * not just because the type changed.
 *
 * 0.86.0 changed the pi-ai provider stream input from Context to normalized
 * TranscriptContext values, restricted ToolCall.arguments / ToolResultMessage
 * details to JSON-compatible values, and made user_bash fail closed; 0.87.0
 * added ContextEditEntry to the SessionEntry union, made SessionManager the
 * canonical provider-context source, and replaced shouldStopAfterTurn with the
 * finishTurn boundary. The SDK paths (session service, model-registry factory)
 * are written against that surface; an older host may resolve but is not a
 * tested or supported target.
 *
 * 0.99.0 added tool `exposure` (including `hidden`, which is how a tool is
 * withdrawn when tools cannot be unregistered) and widened
 * `ToolDefinition.execute()`'s context from `ExtensionContext` to
 * `ExtensionToolContext` (adds `tools` and `executeTool()`). pi-research uses
 * `exposure` to keep an optional tool out of the model's tool list without a
 * restart, and adapts plain contexts with `asToolExecContext()` at the three
 * places it invokes its own tools directly (see utils/tool-exec-context.ts).
 * Relying on either on an older host is a silent misbehaviour rather than a
 * type error — a pre-0.99 host ignores `exposure: hidden` and would declare a
 * withdrawn tool to the model — so the floor moved with the adoption.
 */
export const PI_MIN_VERSION: SemverParts = { major: 0, minor: 99, patch: 0 };

/**
 * Newest host line this release was actually exercised against (CI + a real run).
 * Bump this — deliberately — when a new pi is verified, not automatically.
 * Compared on MAJOR.MINOR only: a patch bump within a tested line is not a new
 * surface, and warning on it would be noise.
 *
 * 1.0.0 is a major version number, not a breaking change for this package. The
 * full public surface was diffed against 0.99.2 (2026-10-01): `@earendil-works/pi-ai`
 * is byte-identical in its declarations, and the extension API
 * (`core/extensions/index.d.ts`, the file every tool, event and context type
 * comes from) is unchanged, as is `docs/extensions.md`. `pi-coding-agent` adds
 * one method (`ModelRegistry.generateImages()`), widens `quietStartup` to
 * `boolean | "header"`, and adds internal fields; `pi-tui` adds
 * `isAppleTerminalSession`, `flattenLines()` and `TUI.getScreenLines()`.
 * Nothing was removed or re-signed, so the 0.99.0 floor still describes the
 * oldest host these APIs exist on.
 *
 * The behavioural changes in 1.0.0 that a user can notice are the fullscreen TUI
 * default (this extension renders through `ctx.ui.*` widgets, which work in both
 * modes), the `builtin:<name>` naming for built-in extensions and tools, and
 * `--no-extensions` now also disabling the built-in extensions. None of them
 * change what this package does.
 */
export const PI_TESTED_MAX_VERSION: SemverParts = { major: 1, minor: 0, patch: 0 };

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

  // A pre-release OF the floor version orders below the floor (0.80.8-rc.1 <
  // 0.80.8) and may predate the very APIs the floor guards.
  if (compareVersions(parsed, min) < 0 || (compareVersions(parsed, min) === 0 && parsed.prerelease === true)) {
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
