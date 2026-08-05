/**
 * EmbeddingServer request authorization.
 *
 * The server binds 127.0.0.1, but loopback is not an authorization boundary: any
 * local process could otherwise enqueue embedding work. That is worse than stolen
 * GPU time — the serial queue steps the leader DOWN when it poisons, so sustained
 * abuse denies the knowledge store for every process in the cluster. The browser
 * server has required a shared secret since #21; the embedding server was the
 * asymmetric gap.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { EmbeddingServer, getEmbeddingServerAuthSecret } from '../../../src/infrastructure/embedding/embedding-server.ts';
import { EmbeddingClient } from '../../../src/infrastructure/embedding/embedding-client.ts';
import type { IEmbedder } from '../../../src/core/interfaces/knowledge-interfaces.ts';

const DIM = 4;

function stubEmbedder(): IEmbedder {
  const vec = () => new Float32Array(DIM).fill(0.5);
  return {
    isInitialized: () => true,
    getDimension: () => DIM,
    initialize: async () => {},
    embed: async () => vec(),
    embedMany: async (texts: string[]) => texts.map(() => vec()),
    dispose: async () => {},
    getDevice: () => 'cpu',
    getOriginalDevice: () => 'cpu',
  } as unknown as IEmbedder;
}

/** Minimal state-manager stub: the server only records/clears its registration. */
function stubStateManager(): any {
  return {
    updateState: async (fn: any) => { await fn({}); },
    clearEmbeddingServer: async () => {},
    getEmbeddingServer: async () => null,
    acquireGpuLock: async () => true,
    releaseGpuLock: async () => {},
  };
}

/** Raw request so we can control (or omit) the auth header. */
function rawGet(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', headers },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    req.end();
  });
}

let server: EmbeddingServer | null = null;

afterEach(async () => {
  if (server) {
    await server.shutdown(false).catch(() => {});
    server = null;
  }
});

describe('EmbeddingServer — request authorization', () => {
  it('rejects a request with NO auth header', async () => {
    server = new EmbeddingServer(stubEmbedder() as never, stubStateManager(), 'test-server');
    const port = await server.startServer();

    await expect(rawGet(port, {})).resolves.toBe(403);
  });

  it('rejects a request with a WRONG secret', async () => {
    server = new EmbeddingServer(stubEmbedder() as never, stubStateManager(), 'test-server');
    const port = await server.startServer();

    await expect(rawGet(port, { 'x-embedding-auth': 'not-the-secret' })).resolves.toBe(403);
    // Same length as the real secret, to exercise the constant-time comparison
    // rather than the length short-circuit.
    const sameLength = 'a'.repeat(getEmbeddingServerAuthSecret().length);
    await expect(rawGet(port, { 'x-embedding-auth': sameLength })).resolves.toBe(403);
  });

  it('accepts a request carrying the correct secret', async () => {
    server = new EmbeddingServer(stubEmbedder() as never, stubStateManager(), 'test-server');
    const port = await server.startServer();

    await expect(rawGet(port, { 'x-embedding-auth': getEmbeddingServerAuthSecret() })).resolves.toBe(200);
  });

  it('lets a properly configured EmbeddingClient embed end-to-end', async () => {
    server = new EmbeddingServer(stubEmbedder() as never, stubStateManager(), 'test-server');
    const port = await server.startServer();

    const client = new EmbeddingClient(port, 'cpu', getEmbeddingServerAuthSecret());
    const vector = await client.embed('hello');

    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(DIM);
  });

  it('a client with no secret is refused (the regression this guards)', async () => {
    server = new EmbeddingServer(stubEmbedder() as never, stubStateManager(), 'test-server');
    const port = await server.startServer();

    const client = new EmbeddingClient(port, 'cpu'); // no secret
    await expect(client.embed('hello')).rejects.toThrow();
  });
});
