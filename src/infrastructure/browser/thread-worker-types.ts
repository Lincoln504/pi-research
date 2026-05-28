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
  buffer?: Buffer;
  html?: string;
  contentType?: string;
}