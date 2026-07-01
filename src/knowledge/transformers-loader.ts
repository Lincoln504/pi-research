/**
 * Lazy loader for the @huggingface/transformers module.
 *
 * Same rationale as ./lancedb-loader.ts. The embedder/knowledge stack is reached
 * only behind a dynamic import() (infrastructure/service-initialization.ts), but
 * esbuild bundles the CLI into a single ESM file with `packages:'external'` and no
 * splitting, and in that mode it HOISTS every *static* `import ... from
 * '@huggingface/transformers'` to the top of the bundle. transformers' Node entry
 * eagerly dlopens the native onnxruntime-node binding at module load, so a hoisted
 * static import evaluates that native load before main() runs — and on any platform
 * where the binding is absent (Intel macOS / darwin-x64, for which onnxruntime-node
 * ships no binary; musl/Alpine; a partial install) the whole bundle fails to
 * evaluate and even `pi-research --help` / `status` exit 1.
 *
 * Loading transformers through a runtime import() keeps esbuild from hoisting it, so
 * the native binding is required only on first real embedder use — where
 * KnowledgeStoreService.initialize() already catches a missing native stack
 * (isNativeStackUnavailableError) and degrades the store to DISABLED. Help, version,
 * status, and browser-only research then work with no binding present.
 *
 * Modules that need transformers *types* should keep `import type { … } from
 * '@huggingface/transformers'` (type imports are erased and never hoisted); only
 * runtime value access (pipeline, env, …) must go through getTransformers().
 */

let _transformers: typeof import('@huggingface/transformers') | undefined;

/** Resolve the transformers module, memoizing after the first load. */
export async function getTransformers(): Promise<typeof import('@huggingface/transformers')> {
  return (_transformers ??= await import('@huggingface/transformers'));
}
