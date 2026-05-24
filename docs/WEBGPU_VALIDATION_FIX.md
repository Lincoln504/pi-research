# WebGPU Validation Error Fix

## Issue Summary

Pi was crashing on startup with the following WebGPU validation error:

```
Error: WebGPU validation failed. [Invalid Buffer (unlabeled)] is invalid.
- While validating entries[0] as a Buffer
Expected entry layout: {type: BufferBindingType::ReadOnlyStorage, minBindingSize: 4, hasDynamicOffset: 0}
- While validating [BindGroupDescriptor ""Gather""] against [BindGroupLayout (unlabeled)]
- While calling [Device].CreateBindGroup([BindGroupDescriptor ""Gather""])
```

Key observation: All `past_key_values.*.key` and `past_key_values.*.value` arrays were empty: `Float32Array(0) []`

## Root Cause

The issue occurs when using **decoder-based embedding models** (like `onnx-community/Qwen3-Embedding-0.6B-ONNX`) with WebGPU backend in `@huggingface/transformers` v4.2.0.

### Technical Details

1. **Decoder Models vs Encoder Models:**
   - Encoder models (BERT, RoBERTa, etc.) process text in one forward pass
   - Decoder models (Qwen, GPT, etc.) generate text autoregressively with `past_key_values` for caching

2. **Past Key Values in Embedding:**
   - For embedding/feature extraction, past_key_values should not be used at all
   - However, the @huggingface/transformers library allocates empty Float32Array(0) buffers for them
   - WebGPU's ReadOnlyStorage buffers require a minimum size of 4 bytes

3. **WebGPU Validation:**
   - WebGPU API performs strict validation before executing GPU operations
   - Zero-sized buffers violate the minimum size constraint for storage buffers
   - The error occurs during bind group creation for the "Gather" operation

## Solution

The fix implements **graceful fallback to CPU** when WebGPU validation errors occur:

### 1. Enhanced Error Detection

Extended `isWebGpuDeviceError()` to detect validation errors:

```typescript
private isWebGpuDeviceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lowerMsg = msg.toLowerCase();
  return (
    lowerMsg.includes('webgpu') ||
    lowerMsg.includes('validation failed') ||
    lowerMsg.includes('invalid buffer') ||
    lowerMsg.includes('bindgroup') ||
    lowerMsg.includes('minbindingsize') ||
    msg.includes('past_key_values') ||
    // ... existing OOM detection
  );
}
```

### 2. Two-Stage Fallback

**Stage 1: Pipeline Loading**
- Catches validation errors during initial model loading
- Falls back to CPU if WebGPU pipeline creation fails

**Stage 2: Warmup Execution**
- Catches validation errors during the warmup call
- Falls back to CPU if warmup fails on WebGPU

### 3. Improved Logging

- Distinguishes between OOM and validation errors
- Logs detailed error messages for debugging
- Provides clear status messages about fallback

## Why This Approach

1. **No Breaking Changes:**
   - Users with compatible models and GPUs continue using WebGPU
   - Only affected models gracefully fall back to CPU

2. **Defensive Programming:**
   - Catches errors at both initialization and warmup stages
   - Prevents crashes by providing a working fallback

3. **User Experience:**
   - Clear logging helps users understand what's happening
   - System continues to work (just slower on CPU)

4. **Future-Proof:**
   - If @huggingface/transformers fixes the issue, models will work on WebGPU again
   - The fallback only triggers on actual validation errors

## Affected Models

Decoder-based embedding models are most likely to trigger this issue:

- `onnx-community/Qwen3-Embedding-0.6B-ONNX` (confirmed)
- Other decoder-based embedding models

Encoder-based models are not affected:

- `Xenova/multilingual-e5-small` (BERT-based)
- `Xenova/bge-m3` (XLM-RoBERTa-based)
- `Xenova/all-MiniLM-L6-v2` (BERT-based)
- etc.

## Testing

1. **Unit Tests:** All existing tests continue to pass
2. **Integration Tests:** Verify fallback behavior with affected models
3. **Manual Testing:** Test with Qwen3 model to confirm CPU fallback works

## Recommendations

1. **For Users:**
   - If you experience WebGPU issues, the system will automatically fall back to CPU
   - Embedding will be slower but functional
   - Consider switching to encoder-based models for better WebGPU compatibility

2. **For Developers:**
   - Monitor @huggingface/transformers updates for fixes
   - Consider adding model compatibility hints in documentation
   - Test new models on WebGPU before recommending them

## Related Issues

- This is related to @huggingface/transformers internal handling of decoder models
- The fix works around the issue at the application level
- A proper fix would require changes to the transformers.js library

## Files Changed

- `src/knowledge/embedder.ts`: Enhanced error detection and fallback logic

## Commit Message

```
fix(embedder): handle WebGPU validation errors for decoder models

- Extended isWebGpuDeviceError() to detect validation errors
- Added CPU fallback on WebGPU validation during pipeline load
- Added CPU fallback on WebGPU validation during warmup  
- Improved error logging to distinguish OOM vs validation errors
- Prevents crashes when using decoder-based models on WebGPU

Fixes WebGPU validation error where zero-sized past_key_values buffers
cause bind group creation failures in ReadOnlyStorage buffers.
```