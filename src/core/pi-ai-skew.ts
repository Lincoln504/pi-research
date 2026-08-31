/**
 * pi-ai module-graph skew detection.
 *
 * The version gate in pi-version.ts classifies the HOST pi-coding-agent
 * version against our supported window — but it cannot see the failure that
 * actually took pi-research down on 2026-08-30: as an extension we resolve
 * `@earendil-works/*` from our OWN node_modules, and when those copies lag the
 * host (host 0.84.4, extension-resolved pi-ai 0.84.2), newer host-era modules
 * and older extension-era modules meet in one process graph. The visible
 * symptom was researchers dying at provider load with
 * "The requested module './simple-options.js' does not provide an export named
 * 'clampThinkingBudgetToAnswerRoom'" (first exported in pi-ai 0.84.3), with
 * the knowledge store's triage/extraction LLM calls failing the same way —
 * every LLM path, wrapped as unrelated-looking "Provider error" strings.
 *
 * Neither npm nor pi enforces agreement here: our declared range
 * (">=0.84.0 <1") cannot constrain the host, and a dev-symlinked or
 * prefix-installed extension keeps whatever node_modules it was installed
 * with while the host updates independently. The only enforcement point is
 * in-process, at load — this module.
 *
 * Detection is deliberately filesystem-based rather than module-resolution-
 * based: the @earendil-works packages' exports maps are import-only, so
 * `createRequire(...).resolve()` fails with ERR_PACKAGE_PATH_NOT_EXPORTED,
 * and resolution would find the same (possibly stale) copy either way. Instead
 * we walk directories to package.json files directly:
 *
 *   - EXTENSION side: from this module's own location up to the package root
 *     (the first package.json — src/ has none), then read
 *     node_modules/@earendil-works/{pi-ai,pi-coding-agent}/package.json.
 *     That is the copy our bare imports actually bind (nearest node_modules).
 *   - HOST side: from the process entry script (process.argv[1], realpath'd —
 *     Node resolves the main entry by default, so an nvm bin symlink anchors
 *     inside the host package) up to the package.json whose name IS
 *     '@earendil-works/pi-coding-agent', then its nested pi-ai. In a pi run
 *     that is the host's own tree; standalone (our CLI/SDK, tests) the walk
 *     finds no such package and the check no-ops rather than guessing.
 *
 * The comparison relies on the pi monorepo's lockstep versioning — every
 * observed release ships pi-coding-agent and pi-ai (and the other
 * @earendil-works/* packages) at the same version — so a mismatch against
 * the host's pi-coding-agent version is a reliable skew signal for pi-ai too.
 * A STALE extension copy (older than the host) is FATAL: that is the proven
 * crash direction. A NEWER extension copy only warns: untested, but no known
 * failure mode. Internal disagreement between the extension's own pi-ai and
 * pi-coding-agent warns as well — a half-updated node_modules.
 */

import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, parsePiVersion } from './pi-version.ts';

/** Minimal package.json shape this module reads. */
interface PkgJson {
  name?: string;
  version?: string;
}

function readPkgJson(file: string): PkgJson | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PkgJson;
  } catch {
    return null;
  }
}

/**
 * Walk up from `startFile` to the nearest package.json.
 * When `name` is given, keep walking past non-matching package.json files
 * (scoped packages nest: pi-coding-agent/dist/bundle/cli.js must climb three
 * levels) and stop at the first match; returns null when never found.
 */
function findPackageRoot(startFile: string, name?: string): { dir: string; pkg: PkgJson } | null {
  let dir = path.dirname(path.resolve(startFile));
  for (let i = 0; i < 16; i++) {
    const pkg = readPkgJson(path.join(dir, 'package.json'));
    if (pkg && (name === undefined || pkg.name === name)) {
      return { dir, pkg };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Version of `@earendil-works/<pkg>` as laid out under `root`'s node_modules, or null. */
function nestedVersion(root: string, pkg: string): string | null {
  const p = readPkgJson(path.join(root, 'node_modules', '@earendil-works', pkg, 'package.json'));
  return p?.version ?? null;
}

export interface PiAiSkewInput {
  /** Host pi-coding-agent version (its package.json), or null when not running under pi. */
  hostVersion: string | null;
  /** Extension-resolved pi-ai version, or null when our node_modules lacks it. */
  extPiAi: string | null;
  /** Extension-resolved pi-coding-agent version, or null. */
  extPiCodingAgent: string | null;
}

export type PiAiSkewLevel = 'ok' | 'standalone' | 'incomplete' | 'stale' | 'newer' | 'internal';

export interface PiAiSkewResult {
  level: PiAiSkewLevel;
  /** True when the extension must refuse to start (proven crash direction). */
  fatal: boolean;
  message: string | null;
}

/**
 * Classify a skew state. Pure — no filesystem access — so the policy is
 * testable without fixtures, mirroring checkPiCompatibility's design.
 */
export function classifyPiAiSkew(input: PiAiSkewInput, extRoot?: string): PiAiSkewResult {
  const { hostVersion, extPiAi, extPiCodingAgent } = input;

  // Standalone CLI/SDK/tests: no host pi package above us — nothing to skew
  // against; our own imports are the only copies in play.
  if (!hostVersion) {
    return { level: 'standalone', fatal: false, message: null };
  }

  const remedy = extRoot
    ? `Fix: cd ${extRoot} && npm install (align this extension's node_modules with host pi ${hostVersion}), then reload pi.`
    : `Fix: reinstall this extension so its node_modules matches host pi ${hostVersion}, then reload pi.`;

  if (!extPiAi || !extPiCodingAgent) {
    // A PRESENT copy that already lags the host is the proven crash direction
    // even in a half-hoisted layout (the 2026-08-30 failure had exactly this
    // shape: stale nested pi-ai beside a hoisted pi-coding-agent) — classify it
    // stale/fatal, not the softer incomplete warn. Only a genuinely-absent
    // copy (nothing to compare) stays warn.
    const presentVersion = extPiAi ?? extPiCodingAgent;
    const presentPkg = extPiAi ? 'pi-ai' : 'pi-coding-agent';
    const present = presentVersion ? parsePiVersion(presentVersion) : null;
    const host = parsePiVersion(hostVersion);
    if (present && host && compareVersions(present, host) < 0) {
      return {
        level: 'stale',
        fatal: true,
        message:
          `[pi-research] Extension node_modules has @earendil-works/${presentPkg} ${presentVersion}, which LAGS host pi ${hostVersion} ` +
          `(${extPiAi ? 'pi-coding-agent' : 'pi-ai'} is not nested here to compare against) — a copy lagging the host crashes every LLM call at provider load ` +
          `(ESM export errors like the missing 'clampThinkingBudgetToAnswerRoom' of pi-ai 0.84.2-vs-0.84.3+). ${remedy}`,
      };
    }
    return {
      level: 'incomplete',
      fatal: false,
      message:
        `[pi-research] Extension node_modules is missing @earendil-works/` +
        `${!extPiAi ? 'pi-ai' : 'pi-coding-agent'} — LLM calls may fail at module load. ${remedy}`,
    };
  }

  const host = parsePiVersion(hostVersion);
  const ai = parsePiVersion(extPiAi);
  const ca = parsePiVersion(extPiCodingAgent);
  if (!host || !ai || !ca) {
    // Unparseable versions: warn, never brick — this guard exists to make
    // failures LOUD, not to invent new startup failures.
    return {
      level: 'incomplete',
      fatal: false,
      message: `[pi-research] Could not parse pi-ai skew versions (host=${hostVersion}, pi-ai=${extPiAi}, pi-coding-agent=${extPiCodingAgent}); skipping skew check.`,
    };
  }

  const aiOlder = compareVersions(ai, host) < 0;
  const caOlder = compareVersions(ca, host) < 0;

  // Internal disagreement (a half-updated node_modules) is the root state and
  // the more precise diagnosis, so it is classified BEFORE the direction
  // checks — otherwise it is unreachable (ai !== ca implies one of them
  // differs from the host). Severity still follows the proven crash
  // direction: fatal when either copy lags the host.
  if (compareVersions(ai, ca) !== 0) {
    const anyOlder = aiOlder || caOlder;
    const base =
      `[pi-research] Extension node_modules is internally inconsistent (pi-ai ${extPiAi} vs ` +
      `pi-coding-agent ${extPiCodingAgent}) — a half-updated install against host pi ${hostVersion}. `;
    if (anyOlder) {
      return {
        level: 'internal',
        fatal: true,
        message:
          base +
          `A copy lagging the host crashes every LLM call at provider load ` +
          `(ESM export errors like the missing 'clampThinkingBudgetToAnswerRoom' ` +
          `of pi-ai 0.84.2-vs-0.84.3+). ${remedy}`,
      };
    }
    return {
      level: 'internal',
      fatal: false,
      message: base + `Untested direction — if LLM calls fail at module load, this is the first suspect. ${remedy}`,
    };
  }

  if (aiOlder || caOlder) {
    // The 2026-08-30 incident: host 0.84.4 + extension pi-ai 0.84.2. Newer
    // host-era modules import symbols the stale copies never exported, and
    // every researcher/knowledge LLM call dies at provider load with a
    // confusing ESM named-export error. Refusing to start with THIS message
    // is strictly better than five silent researcher deaths.
    return {
      level: 'stale',
      fatal: true,
      message:
        `[pi-research] Fatal version skew: host pi ${hostVersion} but this extension resolves ` +
        `pi-ai ${extPiAi} / pi-coding-agent ${extPiCodingAgent}. Mixed-version module graphs crash ` +
        `every LLM call at provider load (ESM export errors like the missing ` +
        `'clampThinkingBudgetToAnswerRoom' of pi-ai 0.84.2-vs-0.84.3+). ${remedy}`,
    };
  }

  const aiNewer = compareVersions(ai, host) > 0;
  const caNewer = compareVersions(ca, host) > 0;
  if (aiNewer || caNewer) {
    return {
      level: 'newer',
      fatal: false,
      message:
        `[pi-research] Extension resolves pi-ai ${extPiAi} / pi-coding-agent ${extPiCodingAgent}, ` +
        `newer than host pi ${hostVersion}. Untested direction — if LLM calls fail at module load, ` +
        `this mismatch is the first suspect. ${remedy}`,
    };
  }

  return { level: 'ok', fatal: false, message: null };
}

/**
 * Collect the real skew state from this process and classify it.
 *
 * Never throws: any read/walk failure degrades to null inputs (classified as
 * 'standalone'/'incomplete'), because a broken guard must not take the
 * extension down with it.
 */
export function checkPiAiSkew(fromFile: string = import.meta.url): PiAiSkewResult {
  // Extension side: nearest package.json above this module = our package root.
  // jiti hands us a file:// URL; real-path strings also accepted.
  const anchor = fromFile.startsWith('file:') ? fileURLToPath(fromFile) : fromFile;
  const ext = findPackageRoot(anchor);
  const extPiAi = ext ? nestedVersion(ext.dir, 'pi-ai') : null;
  const extPiCodingAgent = ext ? nestedVersion(ext.dir, 'pi-coding-agent') : null;

  // Host side: the process entry script, realpath'd. In a pi run this anchors
  // inside the host's own package; anywhere else the named walk finds nothing.
  let hostVersion: string | null = null;
  try {
    const entry = realpathSync(process.argv[1] ?? '');
    const host = findPackageRoot(entry, '@earendil-works/pi-coding-agent');
    hostVersion = host?.pkg.version ?? null;
  } catch {
    // Entry missing/unreadable (standalone context) — hostVersion stays null
    // and classifyPiAiSkew treats the host side as undetectable.
  }

  return classifyPiAiSkew(
    { hostVersion, extPiAi, extPiCodingAgent },
    ext?.dir,
  );
}
