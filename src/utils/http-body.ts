/**
 * Capped response-body reading.
 *
 * `response.json()` and `response.text()` buffer the WHOLE body into the main
 * process before anything can inspect its size — the byte count is only knowable
 * after the memory has already been committed. A hostile or merely broken upstream
 * can therefore drive this process to an OOM kill with a single reply, and because
 * a `Content-Length` header is advisory (absent on chunked encoding, and freely
 * falsifiable) no pre-screen closes that hole. Streaming chunk-by-chunk and
 * aborting the instant the cap is crossed is the only check that actually bounds
 * the allocation.
 *
 * The scraper has read HTML and PDF this way for some time; these helpers exist so
 * the JSON API clients share that one implementation rather than each growing a
 * near-copy of it.
 */

/** Thrown by {@link readBodyCapped} when a streamed body crosses its byte cap. */
export class BodyTooLargeError extends Error {
  constructor(public readonly bytesRead: number, public readonly maxBytes: number) {
    super(`Response body exceeded ${maxBytes} byte cap`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Default cap for a JSON API response.
 *
 * Every endpoint behind these clients answers in kilobytes for a normal query, so
 * 32MB is orders of magnitude of headroom for legitimate traffic while still
 * bounding a runaway body to something a Node heap absorbs without dying. Bulk
 * endpoints that legitimately return more (a full vulnerability catalogue, a
 * maximum-size CVE page) pass their own larger cap explicitly.
 */
export const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Cap for bulk catalogue downloads (CISA KEV's full feed, a 2000-item NVD page).
 * These are legitimately tens of megabytes and grow over time, so they get their
 * own ceiling rather than forcing the shared default up for everyone.
 */
export const MAX_BULK_JSON_BODY_BYTES = 96 * 1024 * 1024;

/**
 * Read a response body with a HARD byte cap, streaming chunk-by-chunk so an
 * over-limit body aborts the moment the cap is crossed.
 *
 * A body-less response (test doubles, some mocks) falls back to `arrayBuffer()`;
 * callers that had a post-read size check keep it as the belt for that path.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  // Also tolerate non-standard doubles that expose a body without getReader.
  if (!body || typeof body.getReader !== 'function') {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw new BodyTooLargeError(total, maxBytes);
        chunks.push(value);
      }
    }
  } finally {
    // Over-cap or downstream throw: release the connection instead of leaving
    // the socket open (and the server still sending) until GC. No-op after a
    // clean done=true read.
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

/**
 * Whether this response can actually be read as a stream — i.e. whether the cap
 * can be enforced at all.
 *
 * A real `Response` from `fetch()` always exposes a `ReadableStream` body except
 * for the null-body statuses (204/205/304), which have nothing to cap. So in
 * production this is true exactly when there are bytes to bound, and the capped
 * path is never quietly skipped. It returns false only for the null-body statuses
 * and for hand-rolled test doubles, which implement whichever of
 * `arrayBuffer()`/`text()`/`json()` they need and no stream at all.
 */
function hasStreamBody(response: Response): boolean {
  const body = response.body;
  return !!body && typeof body.getReader === 'function';
}

/**
 * Capped replacement for `response.text()`.
 *
 * Decodes UTF-8 non-fatally, matching `Response.text()` — a malformed byte becomes
 * U+FFFD rather than throwing, so swapping this in cannot turn a body that used to
 * parse into an exception.
 */
export async function readTextCapped(
  response: Response,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<string> {
  if (hasStreamBody(response)) {
    return new TextDecoder('utf-8').decode(await readBodyCapped(response, maxBytes));
  }
  // Double/null-body ladder — see hasStreamBody for why this is unreachable for a
  // real body-bearing response.
  if (typeof response.arrayBuffer === 'function') {
    return new TextDecoder('utf-8').decode(new Uint8Array(await response.arrayBuffer()));
  }
  return response.text();
}

/**
 * Capped replacement for `response.json()`.
 *
 * Throws {@link BodyTooLargeError} for an over-cap body and a `SyntaxError` for a
 * malformed one, so callers that already distinguish "malformed JSON" from other
 * failures keep working: the size failure is a distinct, catchable type rather
 * than something that masquerades as a parse error.
 */
export async function readJsonCapped<T = unknown>(
  response: Response,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<T> {
  if (hasStreamBody(response) || typeof response.arrayBuffer === 'function' || typeof response.text === 'function') {
    return JSON.parse(await readTextCapped(response, maxBytes)) as T;
  }
  // A double that implements json() alone.
  return response.json() as Promise<T>;
}

/**
 * Accumulator for a Node `IncomingMessage` body that decodes UTF-8 exactly ONCE,
 * at the end.
 *
 * The obvious `body += chunk` is silently lossy. `+=` stringifies each Buffer on
 * its own, so a multi-byte character straddling a chunk boundary is decoded as two
 * independent fragments and both halves become U+FFFD. Chunk boundaries fall
 * wherever the socket happens to split, so the damage scales with payload size and
 * lands only on non-ASCII text — measured at ~15 mangled characters in a 560KB CJK
 * body. Nothing throws: `JSON.parse` still succeeds, so the corruption reaches the
 * report and the knowledge store unannounced.
 *
 * Buffering the chunks and concatenating before a single decode is what makes a
 * split sequence whole again.
 *
 * `byteLength` counts real bytes, which is also the honest unit for a payload cap —
 * the old `body.length` measured UTF-16 code units of an already-corrupted string.
 */
export class Utf8Body {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  /** Total bytes accumulated so far. */
  get byteLength(): number {
    return this.bytes;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }

  /** Concatenate and decode. Safe to call once the stream has ended. */
  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
