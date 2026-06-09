/**
 * Embedding Client
 *
 * HTTP client that implements IEmbedder by forwarding embed/embedMany calls
 * to a remote EmbeddingServer. Mirrors BrowserClient.
 */

import * as http from 'node:http';
import { logger } from '../../logger.ts';
import type { IEmbedder } from '../../core/interfaces/knowledge-interfaces.ts';

export class EmbeddingClient implements IEmbedder {
  // Public so store.ts can set it via `(embedder as any).dimension = dim`
  dimension: number | null = null;

  constructor(
    private readonly port: number,
    private _device: string = 'unknown',
  ) {
    logger.log(`[EmbeddingClient] Connecting to embedding server at http://127.0.0.1:${port}`);
  }

  // ---- IEmbedder ----

  getDevice(): string {
    return this._device;
  }

  getOriginalDevice(): string {
    return this._device;
  }

  getDimension(): number | null {
    return this.dimension;
  }

  isInitialized(): boolean {
    // The server has already initialised; from the client's perspective we are ready.
    return true;
  }

  async embed(text: string): Promise<Float32Array> {
    const resp = await this.request<{ data: number[] }>('/embed', { text });
    return new Float32Array(resp.data);
  }

  async embedMany(texts: string[]): Promise<(Float32Array | number[])[]> {
    const resp = await this.request<{ results: number[][] }>('/embedMany', { texts });
    return resp.results.map(r => new Float32Array(r));
  }

  async dispose(): Promise<void> {
    // Clients don't shut down the server.
  }

  // ---- Health ----

  async fetchHealth(): Promise<void> {
    const result = await this.getRequest<{ status: string; device: string; dimension: number | null }>('/health');
    this._device = result.device;
    if (result.dimension !== null) {
      this.dimension = result.dimension;
    }
  }

  // ---- Internal HTTP helpers ----

  private getRequest<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutMs = 120_000;
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`[EmbeddingClient] GET ${path} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // FIX (#34): Don't keep the event loop alive for timeout timers
      if (timer.unref) timer.unref();

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path,
          method: 'GET',
        },
        (res) => {
          clearTimeout(timer);
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk; });
          res.on('end', () => {
            if (resolved) return;
            resolved = true;
            try {
              const parsed = JSON.parse(body) as T;
              if (res.statusCode !== 200) {
                reject(new Error(`[EmbeddingClient] GET ${path} returned HTTP ${res.statusCode}`));
              } else {
                resolve(parsed);
              }
            } catch (_e) {
              reject(new Error(`[EmbeddingClient] Failed to parse GET ${path} response: ${body}`));
            }
          });
          res.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            reject(new Error(`[EmbeddingClient] GET ${path} response error: ${err.message}`));
          });
        },
      );

      req.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`[EmbeddingClient] GET ${path} request error: ${err.message}`));
      });

      req.end();
    });
  }

  private request<T>(path: string, data: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutMs = 120_000;
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`[EmbeddingClient] POST ${path} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // FIX (#34): Don't keep the event loop alive for timeout timers
      if (timer.unref) timer.unref();

      const body = JSON.stringify(data);

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          clearTimeout(timer);
          let responseBody = '';
          res.on('data', (chunk: Buffer) => { responseBody += chunk; });
          res.on('end', () => {
            if (resolved) return;
            resolved = true;
            try {
              const parsed = JSON.parse(responseBody) as T;
              if (res.statusCode !== 200) {
                const msg = (parsed as Record<string, unknown>)?.['error'];
                reject(new Error(typeof msg === 'string' ? msg : `HTTP ${res.statusCode}`));
              } else {
                resolve(parsed);
              }
            } catch (_e) {
              reject(new Error(`[EmbeddingClient] Failed to parse POST ${path} response: ${responseBody}`));
            }
          });
          res.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            reject(new Error(`[EmbeddingClient] POST ${path} response error: ${err.message}`));
          });
        },
      );

      req.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`[EmbeddingClient] POST ${path} request error: ${err.message}`));
      });

      req.write(body);
      req.end();
    });
  }
}
