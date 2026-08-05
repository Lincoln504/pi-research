/**
 * Capped body reading and chunk-boundary-safe UTF-8 decoding.
 *
 * Two separate hazards live in this module:
 *
 *  1. `response.json()` / `response.text()` buffer the whole body before its size
 *     is knowable, so a hostile or broken upstream can drive an OOM with one reply.
 *  2. `body += chunk` decodes each Buffer independently, so a multi-byte character
 *     split across a chunk boundary becomes two U+FFFD replacements — silently:
 *     JSON.parse still succeeds and the mangled text flows on into the report and
 *     the knowledge store.
 *
 * The second is the one that actually corrupted output, and only for non-ASCII
 * content, which is why it went unnoticed.
 */

import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import {
  readBodyCapped,
  readTextCapped,
  readJsonCapped,
  BodyTooLargeError,
  Utf8Body,
  MAX_JSON_BODY_BYTES,
  MAX_BULK_JSON_BODY_BYTES,
} from '../../../src/utils/http-body.ts';

/** A Response whose body streams in caller-chosen chunks. */
function streamingResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream);
}

describe('readBodyCapped', () => {
  it('returns the whole body when it stays under the cap', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(readBodyCapped(streamingResponse([bytes]), 100)).resolves.toEqual(bytes);
  });

  it('throws BodyTooLargeError as soon as the cap is crossed', async () => {
    const chunk = new Uint8Array(64).fill(7);
    const err = await readBodyCapped(streamingResponse([chunk, chunk, chunk]), 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect((err as BodyTooLargeError).maxBytes).toBe(100);
  });

  it('aborts mid-stream rather than draining an unbounded body', async () => {
    // The point of streaming: an over-cap body must stop being read, not be
    // buffered in full and measured afterwards.
    let chunksPulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled++;
        if (chunksPulled > 1000) { controller.close(); return; }
        controller.enqueue(new Uint8Array(1024));
      },
    });
    await expect(readBodyCapped(new Response(stream), 4096)).rejects.toThrow(BodyTooLargeError);
    // Cap crossed after ~5 chunks; nowhere near the 1000 the producer would emit.
    expect(chunksPulled).toBeLessThan(50);
  });

  it('falls back to arrayBuffer() for a body-less test double', async () => {
    const double = {
      body: null,
      arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
    } as unknown as Response;
    await expect(readBodyCapped(double, 10)).resolves.toEqual(new Uint8Array([9, 9]));
  });
});

describe('readTextCapped / readJsonCapped', () => {
  it('reassembles a multi-byte character split across chunks', async () => {
    // U+1F38C (🎌) is 4 UTF-8 bytes; split it straight down the middle.
    const full = new TextEncoder().encode('🎌');
    const res = streamingResponse([full.slice(0, 2), full.slice(2)]);
    await expect(readTextCapped(res)).resolves.toBe('🎌');
  });

  it('parses JSON and surfaces a size failure as BodyTooLargeError, not a SyntaxError', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    await expect(readJsonCapped(streamingResponse([body]))).resolves.toEqual({ ok: true });

    const err = await readJsonCapped(streamingResponse([body]), 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect(err).not.toBeInstanceOf(SyntaxError);
  });

  it('keeps a malformed body reported as a SyntaxError', async () => {
    const bad = new TextEncoder().encode('{not json');
    await expect(readJsonCapped(streamingResponse([bad]))).rejects.toBeInstanceOf(SyntaxError);
  });

  it('gives bulk endpoints real headroom over the default cap', () => {
    expect(MAX_BULK_JSON_BODY_BYTES).toBeGreaterThan(MAX_JSON_BODY_BYTES);
  });

  it('falls back through arrayBuffer/text/json for doubles that expose no stream', async () => {
    // Test doubles across this suite implement only one of these. The ladder keeps
    // them working WITHOUT weakening production: a real fetch() Response always has
    // a stream body (except null-body statuses, which have nothing to cap), so the
    // capped path is never quietly skipped for real traffic — see hasStreamBody.
    const textOnly = { text: async () => '{"v":1}' } as unknown as Response;
    const jsonOnly = { json: async () => ({ v: 2 }) } as unknown as Response;
    const bufOnly = {
      arrayBuffer: async () => new TextEncoder().encode('{"v":3}').buffer,
    } as unknown as Response;

    await expect(readJsonCapped(textOnly)).resolves.toEqual({ v: 1 });
    await expect(readJsonCapped(jsonOnly)).resolves.toEqual({ v: 2 });
    await expect(readJsonCapped(bufOnly)).resolves.toEqual({ v: 3 });
  });

  it('still enforces the cap whenever a stream body IS present', async () => {
    // The guard on the ladder above: a double that has BOTH a stream and a text()
    // must take the capped path, not the convenient one.
    const bytes = new TextEncoder().encode(JSON.stringify({ big: 'x'.repeat(500) }));
    const withBoth = Object.assign(streamingResponse([bytes]), {
      text: async () => '{"escaped":"the cap"}',
    });
    await expect(readJsonCapped(withBoth, 16)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('Utf8Body', () => {
  it('decodes a multi-byte character split across pushes', () => {
    const bytes = Buffer.from('日', 'utf8'); // 3 bytes
    const b = new Utf8Body();
    b.push(bytes.subarray(0, 1));
    b.push(bytes.subarray(1));
    expect(b.toString()).toBe('日');
  });

  it('counts BYTES, not UTF-16 code units, so a payload cap means what it says', () => {
    const b = new Utf8Body();
    b.push(Buffer.from('🎌', 'utf8'));
    expect(b.byteLength).toBe(4);   // 4 bytes on the wire
    expect(b.toString().length).toBe(2); // 2 UTF-16 code units — the old cap unit
  });

  it('is the difference between clean and corrupted text over a real socket', async () => {
    // End-to-end against a real HTTP server, at a size that guarantees the kernel
    // splits the body across several chunks. This is the exact scenario the browser
    // and embedding clients hit whenever a scraped page is not pure ASCII.
    const payload = JSON.stringify({ content: '日本語のテキスト🎌'.repeat(20_000) });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(Buffer.from(payload, 'utf8'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    const read = (mode: 'concat' | 'collector') => new Promise<string>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
        if (mode === 'collector') {
          const collected = new Utf8Body();
          res.on('data', (c: Buffer) => collected.push(c));
          res.on('end', () => resolve(collected.toString()));
        } else {
          let body = ''; // the pattern this fix removed
          res.on('data', (c: Buffer) => { body += c; });
          res.on('end', () => resolve(body));
        }
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

    try {
      const viaCollector = await read('collector');
      const viaConcat = await read('concat');

      expect(viaCollector).toBe(payload);
      expect(viaCollector).not.toContain('�');

      // Guards the premise: if this ever stops corrupting, the test above has
      // stopped proving anything and should be revisited rather than trusted.
      expect(viaConcat).not.toBe(payload);
      expect(viaConcat).toContain('�');
      // ...and the corruption is silent — the body still parses as valid JSON.
      expect(() => JSON.parse(viaConcat)).not.toThrow();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
