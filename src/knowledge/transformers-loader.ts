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
 * The package itself is an OPTIONAL dependency (it can be skipped entirely at
 * install time when its native chain cannot build — sharp's platform binary is
 * the historic offender, #10). A genuinely absent module is therefore a SUPPORTED
 * state, not a crash: getTransformers() reclassifies it as a typed
 * TRANSFORMERS_UNAVAILABLE error carrying remediation, which the knowledge store's
 * native-unavailable classifier memoizes as DISABLED instead of re-running the
 * init + backoff storm on every store touch. A transformers-INTERNAL load failure
 * (its own onnxruntime import, a corrupt install) is re-thrown untouched — that is
 * the pre-existing native-stack classification's job.
 *
 * Modules that need transformers *types* should keep `import type { … } from
 * '@huggingface/transformers'` (type imports are erased and never hoisted); only
 * runtime value access (pipeline, env, …) must go through getTransformers().
 */

/** Error.code on the typed error thrown when the optional module is not installed. */
export const TRANSFORMERS_UNAVAILABLE = 'TRANSFORMERS_UNAVAILABLE';

/**
 * True when `err` is Node's "the module itself is not installed" rejection for
 * OUR specifier — i.e. the optional dependency was skipped at install time.
 * Deliberately narrow: a transformers-INTERNAL missing module (onnxruntime
 * binding, corrupt install) resolves to a DIFFERENT file path and must stay
 * unclassified here so the native-stack classifier handles it instead.
 */
export function isTransformersMissingError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code?: unknown }).code) : '';
  const msg = err instanceof Error ? err.message : String(err);
  // Node's ESM form is "Cannot find package '@huggingface/transformers' imported
  // from …"; the CJS/child-process form is "Cannot find module '…'".
  return (
    code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
  ) && /@huggingface[/\\]transformers/.test(msg);
}

/**
 * Build the typed, remediation-carrying error for an absent optional package.
 * Exported for tests; the code is what isNativeStackUnavailableError() keys on.
 */
export function transformersUnavailableError(cause: unknown): Error {
  const err = new Error(
    "Optional dependency '@huggingface/transformers' is not installed, so local embeddings are unavailable. "
    + 'npm skips this package when its native image chain cannot install (most often a failing sharp platform binary). '
    + 'The knowledge store runs without embeddings until it is present — reinstall this package to re-resolve its '
    + 'optional dependencies (pi install npm:@lincoln504/pi-research), or install it directly '
    + '(npm install @huggingface/transformers).',
    { cause },
  );
  (err as { code?: string }).code = TRANSFORMERS_UNAVAILABLE;
  return err;
}

let _transformers: typeof import('@huggingface/transformers') | undefined;

/** Resolve the transformers module, memoizing after the first load. */
export async function getTransformers(): Promise<typeof import('@huggingface/transformers')> {
  if (_transformers) return _transformers;
  try {
    _transformers = await import('@huggingface/transformers');
  } catch (err) {
    if (isTransformersMissingError(err)) {
      throw transformersUnavailableError(err);
    }
    throw err;
  }
  return _transformers;
}
