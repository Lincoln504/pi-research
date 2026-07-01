/**
 * ONNX / transformers.js environment setup.
 *
 * `@huggingface/transformers` (which in turn loads the native onnxruntime-node
 * binding) is pulled in LAZILY via ./transformers-loader.ts, never as a static
 * import — otherwise esbuild would hoist it to the top of the CLI bundle and crash
 * startup on any platform lacking the binding (see transformers-loader.ts). Both
 * accessors below are async so the native ML stack loads only when the embedder is
 * actually constructed — i.e. when the knowledge store is enabled and used.
 */

import { HFEnv } from '../core/interfaces/knowledge-interfaces.ts';
import { logger } from '../logger.ts';
import { getModelCacheDir } from './embedder-utils.ts';
import { getTransformers } from './transformers-loader.ts';

/**
 * Get the HuggingFace env object (loads transformers lazily on first call).
 */
export async function getHFEnv() {
  return (await getTransformers()).env;
}

/**
 * Initialize the ONNX environment
 */
let onnxInitialized = false;
export async function initializeONNXEnv(): Promise<void> {
  if (onnxInitialized) return;

  const hfEnv = (await getTransformers()).env;
  hfEnv.cacheDir = getModelCacheDir();

  try {
    const envObj = hfEnv as unknown as HFEnv;
    if (envObj.backends?.onnx) {
      envObj.backends.onnx.logLevel = 'error';
    }
    // Fallback for older transformers.js versions if any
    if ((envObj as any).onnx) {
      (envObj as any).onnx.logLevel = 'error';
    }
  } catch (e) {
    logger.debug('[embedder] Failed to set ONNX logLevel:', e);
  }

  onnxInitialized = true;
}
