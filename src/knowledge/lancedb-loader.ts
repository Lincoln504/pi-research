/**
 * Lazy loader for the @lancedb/lancedb native module.
 *
 * The knowledge store is only reached behind a dynamic import() (see
 * infrastructure/service-initialization.ts, which loads the store service via
 * `await import(...)` inside a lazy service factory). That source-level lazy
 * boundary is, however, defeated by the CLI build: esbuild bundles src/cli.ts
 * into a single ESM file with `packages: 'external'` and no code-splitting, and
 * in that mode it HOISTS every *static* `import` — including transitive ones —
 * to the top of the bundle. A top-of-module `import * as lancedb from
 * '@lancedb/lancedb'` therefore becomes an eager top-level import in dist/cli.mjs,
 * evaluated before main() runs. lancedb's entry eagerly loads its native binding,
 * so on any platform where that binding is absent (Intel macOS — no darwin-x64
 * binding is published; musl/Alpine; or an npm optional-dependency install miss,
 * npm/cli#4828) the whole bundle fails to evaluate and even `pi-research --help`
 * / `status` exit 1.
 *
 * Loading lancedb through a runtime import() instead keeps esbuild from hoisting
 * it (a dynamic import stays a deferred call), so the native binding is required
 * only on first actual store access — exactly where
 * KnowledgeStoreService.initialize() already catches a missing native stack
 * (isNativeStackUnavailableError) and degrades the store to DISABLED. Help,
 * version, status, and browser-only research then work with no binding present.
 *
 * Modules that need lancedb *types* should keep `import type * as lancedb from
 * '@lancedb/lancedb'` (type imports are erased and never hoisted); only runtime
 * value access (connect, Index, rerankers, …) must go through getLancedb().
 */

let _lancedb: typeof import('@lancedb/lancedb') | undefined;

/** Resolve the lancedb module, memoizing after the first load. */
export async function getLancedb(): Promise<typeof import('@lancedb/lancedb')> {
  return (_lancedb ??= await import('@lancedb/lancedb'));
}
