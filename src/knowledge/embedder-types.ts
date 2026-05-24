/**
 * Embedder Types
 *
 * Type definitions for the embedder module
 */

import type { IStateManager } from '../core/service-interfaces.ts';

/**
 * ONNX runtime environment
 */
export interface ONNXRuntimeEnv {
  logLevel?: string;
  debug?: boolean;
}

/**
 * HuggingFace environment with ONNX support
 */
export interface HFEnv {
  cacheDir: string;
  onnx?: ONNXRuntimeEnv;
}

/**
 * Disposable pipeline interface
 */
export interface DisposablePipeline {
  dispose(): Promise<void>;
}

/**
 * Embedder configuration options
 */
export interface EmbedderOptions {
  model: string;
  pooling?: 'mean' | 'cls' | 'last_token';
  queryPrefix?: string;
  initializationTimeoutMs?: number;
  device?: string;
  maxTokens?: number;
  batchSize?: number;
  charsPerToken?: number;
  documentPrefix?: string;
  stateManager?: IStateManager;
  useCache?: boolean;
}

/**
 * Embedder state
 */
export type EmbedderState = 'idle' | 'initializing' | 'ready' | 'failed' | 'disposing';