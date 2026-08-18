/**
 * Embedding Client
 *
 * HTTP client that implements IEmbedder by forwarding embed/embedMany calls
 * to a remote EmbeddingServer. Mirrors BrowserClient.
 */

import * as http from 'node:http';
import { logger } from '../../logger.ts';
import type { IEmbedder } from '../../core/interfaces/knowledge-interfaces.ts';
import { Utf8Body } from '../../utils/http-body.ts';

export class EmbeddingClient implements IEmbedder {
  // Public so store.ts can set the dimension from existing table schema
  // before the embedder has been fully warmed up (see Embedder.setDimension).
  dimension: number | null = null;

  constructor(
    private readonly port: number,
    private _device: string = 'unknown',
    /**
     * Shared secret published by the leader in state. Undefined when the leader
     * predates auth (it does not check a header either), so the request simply
     * carries none — an older leader keeps working rather than 403-ing.
     */
    private readonly authSecret?: string,
  ) {
    logger.log(`[EmbeddingClient] Connecting to embedding server at http://127.0.0.1:${port}`);
  }

  /** Auth header for the leader, or nothing when connecting to a pre-auth leader. */
  private authHeaders(): Record<string, string> {
    return this.authSecret ? { 'x-embedding-auth': this.authSecret } : {};
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

  setDimension(dim: number): void {
    this.dimension = dim;
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

  /**
   * `timeoutMs` defaults to the general-purpose 120s used for real embed requests, but the
   * embedding-leader poll loop (embedding-factory.ts) needs a much shorter deadline: it uses
   * a failed health check as one "unreachable poll" toward declaring a leader's registration
   * stale, on the documented assumption that each poll costs "the poll interval plus up to
   * the [probe] timeout" (~2.5s). At the 120s default that assumption is off by 48x — a
   * leader whose event loop is merely busy (not dead) can take the full 120s to answer, so
   * the poll loop's outer wait times out and retries long before its own unreachable-poll
   * counter would ever fire. Callers that need the fast-fail poll semantics must pass an
   * explicit short timeout.
   */
  async fetchHealth(timeoutMs?: number): Promise<void> {
    const result = await this.getRequest<{ status: string; device: string; dimension: number | null }>('/health', timeoutMs);
    this._device = result.device;
    if (result.dimension !== null) {
      this.dimension = result.dimension;
    }
  }

  // ---- Internal HTTP helpers ----

  private getRequest<T>(path: string, timeoutMs = 120_000): Promise<T> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      let req: http.ClientRequest | undefined;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Destroy the request so a stalled body read is torn down, not left
          // holding the socket until the server eventually closes it.
          req?.destroy();
          reject(new Error(`[EmbeddingClient] GET ${path} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // FIX (#34): Don't keep the event loop alive for timeout timers
      if (timer.unref) timer.unref();

      req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path,
          method: 'GET',
          headers: this.authHeaders(),
        },
        (res) => {
          // Keep the timeout armed through the body read — clearing it on headers
          // would let a stalled body hang for the full process lifetime.
          const collected = new Utf8Body();
          res.on('data', (chunk: Buffer) => { collected.push(chunk); });
          res.on('end', () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(collected.toString()) as T;
              if (res.statusCode !== 200) {
                reject(new Error(`[EmbeddingClient] GET ${path} returned HTTP ${res.statusCode}`));
              } else {
                resolve(parsed);
              }
            } catch (_e) {
              reject(new Error(`[EmbeddingClient] Failed to parse GET ${path} response: ${collected.toString()}`));
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
      let req: http.ClientRequest | undefined;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          req?.destroy();
          reject(new Error(`[EmbeddingClient] POST ${path} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // FIX (#34): Don't keep the event loop alive for timeout timers
      if (timer.unref) timer.unref();

      const body = JSON.stringify(data);

      req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...this.authHeaders(),
          },
        },
        (res) => {
          // Keep the timeout armed through the body read (see getRequest).
          const collected = new Utf8Body();
          res.on('data', (chunk: Buffer) => { collected.push(chunk); });
          res.on('end', () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(collected.toString()) as T;
              if (res.statusCode !== 200) {
                const msg = (parsed as Record<string, unknown>)?.['error'];
                reject(new Error(typeof msg === 'string' ? msg : `HTTP ${res.statusCode}`));
              } else {
                resolve(parsed);
              }
            } catch (_e) {
              reject(new Error(`[EmbeddingClient] Failed to parse POST ${path} response: ${collected.toString()}`));
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
