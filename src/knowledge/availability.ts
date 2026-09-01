/**
 * Knowledge Store availability probe
 *
 * Cheap, execution-free answer to "can the knowledge store possibly run on this
 * host?" — BEFORE anything tries to build it.
 *
 * Why this exists: the store's ML/vector stack lives in two packages that are
 * not guaranteed to be present at runtime —
 *   - `@huggingface/transformers` is an OPTIONAL dependency (skipped wholesale by
 *     `npm install --omit=optional` and by the npm optional-dependency install
 *     bug, npm/cli#4828 — see transformers-loader.ts and issue #10), and
 *   - `@lancedb/lancedb` is a regular dependency whose native binding is absent
 *     on platforms upstream ships no prebuilt for (e.g. darwin-x64).
 *
 * Until now a missing package was only discovered by RUNNING the full
 * embedder+store initialization — which burned MAX_INIT_RETRIES (5) attempts of
 * exponential backoff (~31s) per init before KnowledgeStoreService memoized the
 * failure as DISABLED('native'). Correct outcome, terrible path: every fresh
 * process paid the storm once, and the settings surfaces (research-config TUI,
 * `knowledge-config` CLI, healthcheck) kept advertising a KNOWLEDGE_STORE_MODE
 * that could never actually run.
 *
 * The probe resolves both modules through `require.resolve` — module RESOLUTION
 * only; the module body (and its native bindings) is never executed — so it is
 * safe to call from settings/CLI paths that must not pay the transformers /
 * lancedb load cost. Resolution catches the dominant real-world failure (the
 * package directory absent because an optional dep was skipped or the install
 * is broken); a package that resolves but fails to LOAD its native binding is
 * the residual case and remains covered by the runtime
 * isNativeStackUnavailableError → DISABLED('native') path in
 * knowledge-store-service.ts.
 *
 * Deliberately imports NOTHING from the rest of the project beyond
 * node: builtins — config.ts re-exports its verdict through
 * describeKnowledgeStoreMode, and config.ts must not gain a dependency on the
 * knowledge module graph (knowledge/index.ts imports config.ts).
 */
import { createRequire } from 'node:module';

/** Result of the availability probe. */
export interface KnowledgeStoreAvailability {
  /** True when every required package resolves. */
  available: boolean;
  /** Package specifiers whose absence makes the store unusable, in check order. */
  missing: string[];
}

/**
 * The packages the store cannot run without. `@lancedb/lancedb` is the vector
 * store itself; `@huggingface/transformers` is the only embedding backend
 * (see transformers-loader.ts — there is no remote-embedding fallback).
 */
const REQUIRED_PACKAGES: readonly string[] = ['@lancedb/lancedb', '@huggingface/transformers'];

// Memoized per-process: resolution touches the filesystem on every miss, the
// answer cannot change within a live process without a reinstall mid-flight,
// and the probe sits on settings/health paths that run often. Tests reset it
// via clearAvailabilityCache.
let _cached: KnowledgeStoreAvailability | null = null;

/** Resolver signature — injectable so tests never need the real filesystem. */
export type PackageResolver = (specifier: string) => string;

/**
 * Default resolver: root at THIS module's install tree, so resolution follows
 * pi-research's own node_modules (where the optional deps would be) rather
 * than whatever directory the caller happens to run from.
 */
const defaultResolver: PackageResolver = (specifier) =>
  // import.meta.url survives esbuild's ESM output; createRequire only builds a
  // resolver — it never evaluates the specifier.
  createRequire(import.meta.url).resolve(specifier);

/**
 * Probe whether the knowledge store's required packages are resolvable.
 * Memoized after the first call; {@link clearAvailabilityCache} resets.
 */
export function probeKnowledgeStoreAvailability(resolver: PackageResolver = defaultResolver): KnowledgeStoreAvailability {
  if (cachedIsValidFor(resolver)) return _cached!;
  const missing: string[] = [];
  for (const pkg of REQUIRED_PACKAGES) {
    try {
      resolver(pkg);
    } catch {
      // require.resolve throws ERR_MODULE_NOT_FOUND / ERR_PACKAGE_PATH_NOT_EXPORTED
      // / MODULE_NOT_FOUND for every "not installable here" shape we care about.
      missing.push(pkg);
    }
  }
  const result: KnowledgeStoreAvailability = { available: missing.length === 0, missing };
  if (resolver === defaultResolver) _cached = result;
  return result;
}

function cachedIsValidFor(resolver: PackageResolver): boolean {
  return _cached !== null && resolver === defaultResolver;
}

/** Reset the memoized probe result (test isolation). */
export function clearAvailabilityCache(): void {
  _cached = null;
}

/**
 * Human sentence for why the store is unavailable — empty when available.
 * Used by the settings surfaces (describeKnowledgeStoreMode, the
 * /research-config TUI, the healthcheck) so every surface words it the same.
 */
export function describeKnowledgeStoreUnavailability(availability: KnowledgeStoreAvailability): string {
  if (availability.available) return '';
  const parts = availability.missing.map((pkg) =>
    pkg === '@huggingface/transformers'
      ? `'${pkg}' (optional embedding dependency — likely skipped at install time)`
      : `'${pkg}' (broken install — native vector store missing)`,
  );
  return `knowledge store is OFF: required package${parts.length > 1 ? 's' : ''} not resolvable — ${parts.join('; ')}. ` +
    "Repair with a full install of optional dependencies (e.g. 'npm install' including optional deps, or pi install npm:@lincoln504/pi-research without --omit=optional).";
}
