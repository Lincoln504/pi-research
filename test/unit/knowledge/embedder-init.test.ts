import { describe, it, expect, vi } from 'vitest';
import { isWebGpuDeviceError } from '../../../src/knowledge/embedder-init.ts';

describe('Embedder Init - isWebGpuDeviceError', () => {
  it('should return false for null or undefined', () => {
    expect(isWebGpuDeviceError(null)).toBe(false);
    expect(isWebGpuDeviceError(undefined)).toBe(false);
  });

  it('should detect WebGPU errors in Error objects', () => {
    expect(isWebGpuDeviceError(new Error('WebGPU is not supported'))).toBe(true);
    expect(isWebGpuDeviceError(new Error('OUT_OF_DEVICE_MEMORY'))).toBe(true);
    expect(isWebGpuDeviceError(new Error('Device lost'))).toBe(true);
    expect(isWebGpuDeviceError(new Error('Validation failed'))).toBe(true);
  });

  it('should detect WebGPU errors in plain objects', () => {
    expect(isWebGpuDeviceError({ message: 'out-of-memory' })).toBe(true);
    expect(isWebGpuDeviceError({ stack: 'at createDevice (native)' })).toBe(true);
  });

  it('should detect WebGPU errors in strings', () => {
    expect(isWebGpuDeviceError('vk_error_out_of_device_memory')).toBe(true);
  });

  it('should return false for unrelated errors', () => {
    expect(isWebGpuDeviceError(new Error('File not found'))).toBe(false);
    expect(isWebGpuDeviceError('Network timeout')).toBe(false);
    expect(isWebGpuDeviceError({ foo: 'bar' })).toBe(false);
  });

  it('should handle all 17 patterns', () => {
    const patterns = [
      'webgpu', 'out_of_device_memory', 'out of memory', 'vk_error_out_of_device_memory',
      'vkallocatememory', 'device lost', 'devicelost', 'validation failed',
      'invalid buffer', 'bindgroup', 'minbindingsize', 'past_key_values',
      'unlabeled', 'bufferbindingtype', 'createdevice', 'createbindgroup', 'out-of-memory'
    ];
    
    for (const pattern of patterns) {
      expect(isWebGpuDeviceError(`Error: ${pattern}`)).toBe(true);
    }
  });
});
