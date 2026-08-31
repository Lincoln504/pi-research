import { describe, it, expect } from 'vitest';
import {
  isTransformersMissingError,
  transformersUnavailableError,
  TRANSFORMERS_UNAVAILABLE,
} from '../../../src/knowledge/transformers-loader.ts';
import { isNativeStackUnavailableError } from '../../../src/knowledge/embedder-utils.ts';

/**
 * The package is an OPTIONAL dependency: npm skips it wholesale when its native
 * chain cannot install (sharp's platform binary is the historic trigger, #10).
 * getTransformers() must convert that specific, SUPPORTED state into a typed
 * error with remediation — and must leave every other load failure (a
 * transformers-internal onnxruntime failure, a corrupt install) untouched so
 * the pre-existing native-stack classification keeps handling them.
 *
 * The import specifier is mocked at the module boundary so these tests do not
 * need the real (heavy, native) package.
 */
function missingModuleError(message: string, code = 'ERR_MODULE_NOT_FOUND'): Error {
  return Object.assign(new Error(message), { code });
}

vi.mock('@huggingface/transformers', () => {
  throw missingModuleError(
    "Cannot find package '@huggingface/transformers' imported from /x/transformers-loader.ts",
  );
});

describe('isTransformersMissingError', () => {
  it('matches the ESM not-found form naming our specifier', () => {
    expect(isTransformersMissingError(missingModuleError(
      "Cannot find package '@huggingface/transformers' imported from /x/transformers-loader.ts",
    ))).toBe(true);
  });

  it('matches the CJS not-found form naming our specifier', () => {
    expect(isTransformersMissingError(missingModuleError(
      "Cannot find module '@huggingface/transformers'",
      'MODULE_NOT_FOUND',
    ))).toBe(true);
  });

  it('does NOT match a missing module that merely mentions transformers in a path', () => {
    expect(isTransformersMissingError(missingModuleError(
      "Cannot find module '/x/transformers-helper/lib/index.js'",
    ))).toBe(false);
  });

  it('does NOT match transformers-INTERNAL failures (native stack classification owns those)', () => {
    // onnxruntime missing underneath a PRESENT transformers package: a different
    // failure class with its own classifier — must pass through untouched.
    expect(isTransformersMissingError(missingModuleError(
      "Cannot find module 'onnxruntime-node'",
    ))).toBe(false);
    expect(isTransformersMissingError(new Error('connect ECONNREFUSED'))).toBe(false);
    expect(isTransformersMissingError(null)).toBe(false);
    expect(isTransformersMissingError(undefined)).toBe(false);
  });
});

describe('getTransformers absent-module handling (the catch-block constituents)', () => {
  // getTransformers()' catch block is exactly:
  //   if (isTransformersMissingError(err)) throw transformersUnavailableError(err);
  // The mock boundary (vi.mock factory throws) gets wrapped by the test runner
  // itself, so the wire-up is pinned here by testing both constituents against
  // the real Node error shapes instead.
  const nodeMissing = missingModuleError(
    "Cannot find package '@huggingface/transformers' imported from /x/transformers-loader.ts",
  );

  it('classifies the real Node missing-module rejection as absent and types it', () => {
    expect(isTransformersMissingError(nodeMissing)).toBe(true);
    const typed = transformersUnavailableError(nodeMissing);
    expect((typed as { code?: string }).code).toBe(TRANSFORMERS_UNAVAILABLE);
    expect(typed.message).toContain("'@huggingface/transformers'");
    expect(typed.message).toContain('optional');
    expect(typed.message).toContain('pi install npm:@lincoln504/pi-research');
    expect(typed.message).toContain('npm install @huggingface/transformers');
    expect(typed.cause).toBe(nodeMissing);
  });

  it('does NOT classify a transformers-INTERNAL failure — it must stay untouched', () => {
    const internal = missingModuleError("Cannot find module 'onnxruntime-node'");
    expect(isTransformersMissingError(internal)).toBe(false);
    // And the downstream store classifier treats it via the onnxruntime arm,
    // NOT the transformers arm:
    expect(isNativeStackUnavailableError(internal)).toBe(true);
  });

  it('the typed error feeds the store classifier → DISABLED memoization path', () => {
    expect(isNativeStackUnavailableError(transformersUnavailableError(nodeMissing))).toBe(true);
  });

  it('an unrelated missing module is neither transformers-absent nor native-stack-unavailable', () => {
    const other = missingModuleError("Cannot find module 'left-pad'");
    expect(isTransformersMissingError(other)).toBe(false);
    expect(isNativeStackUnavailableError(other)).toBe(false);
  });
});
