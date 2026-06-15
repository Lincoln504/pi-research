/**
 * ONNX / transformers.js environment setup.
 *
 * This is the ONLY knowledge-layer module that statically imports
 * `@huggingface/transformers` (which in turn loads the native onnxruntime-node
 * binding). It is intentionally separated from `embedder-utils.ts` so that the
 * extension's load path (src/index.ts → embedder-utils for the beforeExit safety
 * net) never eagerly loads the native ML stack. The native binding is only
 * pulled in when the embedder itself is constructed — i.e. when the knowledge
 * store is actually enabled and used.
 */

import { env as hfEnv } from '@huggingface/transformers';
import { HFEnv } from '../core/interfaces/knowledge-interfaces.ts';
import { logger } from '../logger.ts';
import { getModelCacheDir } from './embedder-utils.ts';

/**
 * Get the HuggingFace env object
 */
export function getHFEnv() {
  return hfEnv;
}

/**
 * Initialize the ONNX environment
 */
let onnxInitialized = false;
export function initializeONNXEnv(): void {
  if (onnxInitialized) return;

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
