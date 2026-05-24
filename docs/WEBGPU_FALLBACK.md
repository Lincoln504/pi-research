# WebGPU Fallback Mechanism

## Overview

The pi-research extension implements a robust WebGPU fallback mechanism to ensure reliable startup across different hardware configurations and embedding models. This is particularly important because:

1. **Encoder models** (e.g., BERT, MiniLM, MPNet, E5) work well with WebGPU
2. **Decoder models** (e.g., Qwen3-Embedding-0.6B) often fail WebGPU validation due to buffer binding constraints with `past_key_values` tensors

## How It Works

### 1. Initialization Phase (Startup)

When `initKnowledgeStore()` is called:

1. **First attempt**: Try to initialize with WebGPU (if configured)
2. **If WebGPU fails**: Automatically fall back to CPU within the same initialization attempt
3. **If CPU also fails**: Propagate the error and retry (up to 5 times)
4. **Fallback flag**: After a WebGPU fallback occurs, a module-level flag prevents future embedder instances from retrying WebGPU

### 2. Error Detection

The fallback mechanism detects WebGPU errors by checking for:

- **Validation errors**: Messages containing "validation", "invalid buffer", "bindgroup", or "minbindingsize"
- **OOM errors**: Messages containing "out_of_device_memory", "vk_error_out_of_device_memory", or "vkallocatememory"
- **Decoder model indicators**: Messages containing "past_key_values"
- **Device lost**: Messages containing "device lost" or "devicelost"
- **WebGPU-specific**: Messages containing "webgpu" in general error contexts

### 3. Fallback Locations

WebGPU fallback can occur at two points during initialization:

#### A. Pipeline Loading

```typescript
// In _initializeInternal()
try {
  this.pipeline = await pipeline('feature-extraction', this.model, { device: 'webgpu' });
} catch (loadErr) {
  if (this.isWebGpuDeviceError(loadErr)) {
    // Fall back to CPU
    this.device = 'cpu';
    this.pipeline = await pipeline('feature-extraction', this.model, { device: 'cpu' });
    // Warmup CPU pipeline to ensure it's functional
    await this.pipeline('warmup', ...);
  }
}
```

#### B. Warmup

```typescript
try {
  await this.pipeline('warmup', ...);
} catch (warmupErr) {
  if (this.isWebGpuDeviceError(warmupErr)) {
    // Fall back to CPU
    this.device = 'cpu';
    this.pipeline = await pipeline('feature-extraction', this.model, { device: 'cpu' });
    // Warmup CPU pipeline
    await this.pipeline('warmup', ...);
  }
}
```

### 4. Fallback Flag (Session-Level)

The module-level `hasWebGpuFallbackOccurred` flag:

- **Set** when any embedder instance falls back from WebGPU to CPU
- **Checked** by new embedder instances to skip WebGPU entirely
- **Reset** after successful knowledge store initialization (allows retry next session)

This prevents the retry loop from repeatedly trying WebGPU after it's been proven to fail.

```typescript
// In Embedder constructor
this.device = hasWebGpuFallbackOccurred && this.originalDevice === 'webgpu' 
  ? 'cpu' 
  : this.originalDevice;
```

### 5. Recovery During Operations

Even after successful initialization, WebGPU errors during `embed()` or `embedMany()` operations trigger a recovery:

```typescript
async embed(text: string): Promise<Float32Array> {
  try {
    return await this.pipeline!(text, this.pipelineOpts());
  } catch (err) {
    if (this.isWebGpuDeviceError(err)) {
      await this.recoverToCpu();  // Dispose WebGPU pipeline, reload on CPU
      return await this.pipeline!(text, this.pipelineOpts());
    }
    throw err;
  }
}
```

## Device Tracking

The embedder tracks both the requested and actual device:

- `getDevice()`: Returns the actual device in use ('webgpu' or 'cpu')
- `getOriginalDevice()`: Returns the originally requested device from config

This allows logging and diagnostics:

```typescript
logger.info(`[knowledge] Knowledge Store ready. Device: ${actualDevice} (fallback from ${originalDevice})`);
```

## Error Handling

### WebGPU → CPU Fallback

**Success path**:
1. WebGPU fails with validation/OOM
2. CPU pipeline loads successfully
3. CPU warmup succeeds
4. Embedder is ready with `device = 'cpu'`
5. Fallback flag is set
6. Initialization completes successfully

**Failure path**:
1. WebGPU fails with validation/OOM
2. CPU pipeline load also fails → Throw: "WebGPU failed and CPU fallback load also failed"
3. CPU pipeline loads, but warmup fails → Throw: "WebGPU failed and CPU fallback warmup also failed"

### Retries

The `initKnowledgeStore()` retry logic:

- **Max retries**: 5
- **Backoff**: Exponential (1s, 2s, 4s, 8s, 16s + random jitter)
- **Permanent failure**: After all retries exhausted, set `initializationPermanentlyFailed = true`

With the fallback flag, retries after a WebGPU fallback will use CPU directly, avoiding repeated failures.

## Logging

Clear logging helps diagnose fallback behavior:

```log
[embedder] Loading model: Xenova/all-MiniLM-L6-v2 (from local cache)...
[embedder] Pipeline loaded (device: webgpu)
[embedder] WebGPU validation error during warmup (likely buffer binding issue with decoder model) — falling back to CPU
[embedder] Loading model on CPU after WebGPU validation error...
[embedder] CPU pipeline loaded successfully
[embedder] CPU pipeline warmup successful. Ready with device: cpu
[knowledge] Knowledge Store ready. Device: cpu (fallback from webgpu)
```

On subsequent embedder instances (if fallback flag is set):

```log
[embedder] Skipping WebGPU (previous fallback detected), using CPU directly
[embedder] Loading model: Xenova/all-MiniLM-L6-v2 (from local cache)...
[embedder] Pipeline loaded (device: cpu)
[embedder] Ready. Dimension: 384, device: cpu
```

## Model Compatibility

### Encoder Models (WebGPU Recommended)

- `Xenova/all-MiniLM-L6-v2` ✓ WebGPU
- `Xenova/bge-small-en-v1.5` ✓ WebGPU
- `Xenova/all-mpnet-base-v2` ✓ WebGPU
- `Xenova/multilingual-e5-small` ✓ WebGPU
- `Xenova/bge-m3` ✓ WebGPU
- `onnx-community/granite-embedding-small-english-r2-ONNX` ✓ WebGPU

### Decoder Models (CPU Fallback Expected)

- `onnx-community/Qwen3-Embedding-0.6B-ONNX` ✗ WebGPU validation errors → CPU fallback
- `onnx-community/embeddinggemma-300m-ONNX` ✗ May require CPU fallback

## Testing

The fallback mechanism is tested in:

- `test/unit/knowledge/embedder-fallback.test.ts` - Direct embedder fallback tests
- `test/unit/knowledge/embedder.test.ts` - General embedder tests including recovery

## Configuration

The fallback respects the `EMBEDDING_DEVICE` config:

```env
# Try WebGPU first, fall back to CPU if it fails
PI_RESEARCH_EMBEDDING_DEVICE=webgpu

# Force CPU (no fallback)
PI_RESEARCH_EMBEDDING_DEVICE=cpu
```

## Best Practices

1. **Let the fallback work**: Don't manually set `EMBEDDING_DEVICE=cpu` unless you have a specific reason
2. **Monitor logs**: Check startup logs to see which device was actually used
3. **Resource considerations**: CPU fallback uses more RAM and is slower than WebGPU
4. **Model selection**: For encoder models on modern hardware, WebGPU is preferred
5. **Decoder models**: Expect CPU fallback to occur for Qwen3-Embedding and similar

## Troubleshooting

### WebGPU Fails But CPU Also Fails

- **Symptom**: "WebGPU failed and CPU fallback also failed"
- **Cause**: System insufficient resources or model corruption
- **Fix**:
  - Free up RAM
  - Use a smaller model (e.g., `all-MiniLM-L6-v2` instead of `all-mpnet-base-v2`)
  - Clear model cache: `rm -rf ~/.cache/pi-research/models/<model-id>`

### Slow CPU Embeddings

- **Symptom**: Embeddings take 500ms+ per query on CPU
- **Cause**: Using CPU fallback on a slow system
- **Fix**:
  - Use a smaller/faster model: `Xenova/all-MiniLM-L6-v2`
  - Reduce `maxTokens` in model config
  - Reduce `batchSize` for batch operations

### Repeated WebGPU Retries

- **Symptom**: Logs show multiple WebGPU attempts in one session
- **Cause**: Fallback flag not being set (bug) or manually reset
- **Fix**: This should not happen with the current implementation. Report if observed.