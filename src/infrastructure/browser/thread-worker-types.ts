/**
 * Thread Worker Types
 *
 * Shared types for thread worker modules.
 */

export interface TaskData {
  type: string;
  query?: string;
  url?: string;
  queuedAt?: number;
  taskTimeoutMs?: number;
}

export interface TaskResult {
  results?: any[];
  duration: number;
  jitter?: number;
  error?: string;
  success?: boolean;
  navMs?: number;
  /** PDF bytes, base64-encoded: a raw Buffer would be mangled to
   *  {type:'Buffer',data:[...]} by the cluster-IPC JSON serialization. */
  bufferB64?: string;
  html?: string;
  contentType?: string;
}