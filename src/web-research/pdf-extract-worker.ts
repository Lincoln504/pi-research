/**
 * PDF extraction worker entry — bundled by scripts/build.cjs into
 * pdf-extract-worker.mjs and spawned by pdf-extraction.ts.
 *
 * Deliberately dumb: receive {id, bytes}, run the SAME parsePdfCore the
 * in-process path runs (one code path, no behavioral drift), post the
 * classified result back. All metrics/logging stay parent-side so both paths
 * emit identically.
 */

import { parentPort } from 'node:worker_threads';
import { parsePdfCore, PdfExtractError } from './pdf-extraction.ts';

interface WorkerRequest {
  id: number;
  bytes: Uint8Array;
}

if (parentPort !== null) {
  const port = parentPort;
  port.on('message', (msg: WorkerRequest) => {
    void (async () => {
      try {
        const result = await parsePdfCore(msg.bytes);
        port.postMessage({ id: msg.id, ok: true, markdown: result.markdown, pageCount: result.pageCount });
      } catch (e) {
        if (e instanceof PdfExtractError) {
          // Worker-side structured clone drops Error causes — the kind and the
          // message (the load-bearing classification strings) always survive.
          port.postMessage({ id: msg.id, ok: false, kind: e.kind, message: e.message });
        } else {
          port.postMessage({
            id: msg.id,
            ok: false,
            kind: 'extraction_failed',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })();
  });
}
