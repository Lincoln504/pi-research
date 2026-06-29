import { describe, it, expect } from 'vitest';
import { isNativeStackUnavailableError } from '../../../src/knowledge/embedder-utils.ts';

describe('isNativeStackUnavailableError', () => {
  it('matches the onnxruntime-node missing-prebuilt error (Intel macOS / darwin-x64)', () => {
    const err = new Error(
      "Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'"
    );
    expect(isNativeStackUnavailableError(err)).toBe(true);
  });

  it('matches the @lancedb/lancedb missing native binding error', () => {
    const err = new Error(
      'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again.'
    );
    expect(isNativeStackUnavailableError(err)).toBe(true);
  });

  it('matches the jiti-masked module-eval failure surfaced as a constructor error', () => {
    const err = new TypeError('KnowledgeStoreService is not a constructor');
    expect(isNativeStackUnavailableError(err)).toBe(true);
  });

  it('matches when the signature only appears in the stack, not the message', () => {
    const err = new Error('factory failed');
    err.stack = "Error: factory failed\n    at load (.../onnxruntime_binding.node)";
    expect(isNativeStackUnavailableError(err)).toBe(true);
  });

  it('matches a failed native dlopen by error code, regardless of message wording', () => {
    // ERR_DLOPEN_FAILED is emitted when a .node addon fails to load. The message
    // wording varies across Node versions, but the code is stable.
    const err = Object.assign(new Error('some future reworded native load failure'), { code: 'ERR_DLOPEN_FAILED' });
    expect(isNativeStackUnavailableError(err)).toBe(true);
  });

  it('matches a module-not-found by code when it names a native package', () => {
    const err = Object.assign(new Error('Cannot locate package onnxruntime-node'), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(isNativeStackUnavailableError(err)).toBe(true);
  });

  it('does NOT match a module-not-found for an unrelated package', () => {
    const err = Object.assign(new Error("Cannot find module 'left-pad'"), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(isNativeStackUnavailableError(err)).toBe(false);
  });

  it('does NOT match unrelated runtime errors (real faults must stay unhealthy)', () => {
    expect(isNativeStackUnavailableError(new Error('connect ECONNREFUSED 127.0.0.1:7070'))).toBe(false);
    expect(isNativeStackUnavailableError(new Error('Model load timed out after 30000ms'))).toBe(false);
    expect(isNativeStackUnavailableError(new Error('WebGPU device lost'))).toBe(false);
  });

  it('is null/undefined safe', () => {
    expect(isNativeStackUnavailableError(null)).toBe(false);
    expect(isNativeStackUnavailableError(undefined)).toBe(false);
    expect(isNativeStackUnavailableError('')).toBe(false);
  });
});
