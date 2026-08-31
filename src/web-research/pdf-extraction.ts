/**
 * PDF extraction — off the main thread when possible, identical when not.
 *
 * Relocated verbatim from web-scraper.ts (which previously ran the whole
 * parse inline) to fix its own recorded TODO(hardening, medium): the
 * pdf-oxide-wasm parse is irreducibly synchronous (wasm-bindgen, no async
 * API), so a large/complex PDF blocks the MAIN process's event loop for
 * seconds — starving every concurrent scrape, the TUI render loop, and
 * timers.
 *
 * The parse now runs in a dedicated worker_threads Worker (NOT the browser
 * pool: cluster IPC would JSON-serialize the bytes — the exact hazard behind
 * the bufferB64 round-trip — a pool worker eagerly boots Firefox before any
 * task, and poolifier never settles in-flight execute() promises on worker
 * death). postMessage transfers the byte buffer zero-copy after a defensive
 * slice(); a wedged worker is terminate()d on timeout — the only way to
 * interrupt a sync wasm call — and the parse retried once in-process.
 *
 * Behavioral contract (byte-identical to the web-scraper original):
 *   - error STRINGS and their classification kinds are load-bearing:
 *     isBenignScrapeFailure distinguishes 'Could not extract content from
 *     PDF (…)' (benign, per-URL) from 'PDF extraction unavailable
 *     (pdf-oxide-wasm failed to load: …)' (infrastructure, NOT benign);
 *   - metrics: scrape_pdf_conversion_ms / scrape_pdf_conversions_total{status,
 *     pages} on success, scrape_pdf_errors_total{error_type} per failure kind;
 *   - log levels: warn (size), error (native module), debug (extraction);
 *   - WasmPdfDocument.free() runs on every exit path (native memory is not
 *     GC-reclaimed).
 *
 * The worker bundle (pdf-extract-worker.mjs) is built by scripts/build.cjs
 * next to this file; when absent (unbuilt dev tree, exotic install) the
 * in-process path runs unchanged — bounded by MAX_PDF_SIZE and the scrape
 * task's deadline, exactly like before. PI_RESEARCH_PDF_WORKER=off disables
 * the worker path outright (also the vitest default, so the module-level
 * vi.mock('pdf-oxide-wasm') seams keep reaching the parse).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

// ESM-safe module directory. Bare __dirname is undefined in the bundled
// dist/cli.mjs (esbuild format: 'esm') and in jiti-loaded ESM — before this
// fix the packaged CLI threw ReferenceError on the first PDF and every
// extraction failed. Same pattern as worker-pool-manager.ts.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { errorTracker } from '../utils/error-tracker.ts';
import { MAX_PDF_SIZE } from './scraper-types.ts';

// ============================================================================
// Classified errors — the classification contract survives the worker hop.
// ============================================================================

export type PdfExtractErrorKind = 'size_exceeded' | 'native_module_unavailable' | 'extraction_failed';

export class PdfExtractError extends Error {
  readonly kind: PdfExtractErrorKind;
  constructor(kind: PdfExtractErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfExtractError';
    this.kind = kind;
  }
}

// ============================================================================
// In-process parse core (also the worker's payload — one code path).
// ============================================================================

interface PdfModule {
  WasmPdfDocument: new (bytes: Uint8Array) => {
    pageCount(): number;
    toMarkdownAll(): string;
    toMarkdown(page: number): string;
    free(): void;
  };
}

let pdfModulePromise: Promise<PdfModule> | null = null;

/** Cached dynamic import — vitest's vi.mock('pdf-oxide-wasm') seam keeps working. */
function loadPdfModule(): Promise<PdfModule> {
  if (pdfModulePromise === null) {
    pdfModulePromise = import('pdf-oxide-wasm') as Promise<PdfModule>;
  }
  return pdfModulePromise;
}

export interface PdfParseResult {
  markdown: string;
  pageCount: number;
}

/**
 * The parse itself: size guard, module load (caught SEPARATELY from parse —
 * an infrastructure fault is not a per-PDF outcome), doc.free() on every
 * exit, toMarkdownAll with per-page fallback. Throws PdfExtractError with
 * the historical message strings; no metrics/logging here so the caller can
 * emit them once regardless of which context did the work.
 */
export async function parsePdfCore(bytes: Uint8Array): Promise<PdfParseResult> {
  if (bytes.length > MAX_PDF_SIZE) {
    const sizeMB = Math.round(bytes.length / 1024 / 1024);
    // THROW, never an in-band "*Error: ...*" string: a returned banner flowed
    // into validateContent as if it were page content (see git history).
    throw new PdfExtractError('size_exceeded', `PDF too large (${sizeMB}MB, max 100MB)`);
  }

  let WasmPdfDocument: PdfModule['WasmPdfDocument'];
  try {
    ({ WasmPdfDocument } = await loadPdfModule());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Deliberately does NOT start with 'Could not extract content from PDF' —
    // isBenignScrapeFailure must NOT classify this as routine.
    throw new PdfExtractError(
      'native_module_unavailable',
      `PDF extraction unavailable (pdf-oxide-wasm failed to load: ${msg})`,
      { cause: e },
    );
  }

  try {
    const doc = new WasmPdfDocument(bytes);
    // free() is native/WASM-side memory, not GC-reclaimed — must run on every
    // exit, including when toMarkdownAll() AND the per-page fallback throw.
    try {
      const pageCount = doc.pageCount();
      let markdown = `# PDF Document\n\n**Pages:** ${pageCount}\n\n`;
      try {
        markdown += doc.toMarkdownAll();
      } catch {
        for (let i = 0; i < pageCount; i++) {
          markdown += `## Page ${i + 1}\n\n${doc.toMarkdown(i)}\n\n`;
        }
      }
      return { markdown, pageCount };
    } finally {
      doc.free();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // See size branch: a failure must FAIL the scrape, not travel in-band.
    throw new PdfExtractError('extraction_failed', `Could not extract content from PDF (${msg})`, { cause: e });
  }
}

// ============================================================================
// Worker transport.
// ============================================================================

const WORKER_FILENAME = 'pdf-extract-worker.mjs';
/** Sync wasm cannot be cancelled; terminate() after this and retry in-process. */
const PDF_WORKER_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (r: PdfParseResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The Worker instance serving this request — timeout teardown must target
   * THIS worker, never whatever is current when the timer fires. */
  worker: Worker;
}

let pdfWorker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();
let warnedWorkerUnavailable = false;

type WorkerInvoke = (bytes: Uint8Array) => Promise<PdfParseResult>;

function resolveWorkerPath(): string | null {
  const candidate = join(MODULE_DIR, WORKER_FILENAME);
  return existsSync(candidate) ? candidate : null;
}

/** True when the worker bundle is present next to this module and the off
 *  kill-switch is not set. Exported for the regression test that pins the
 *  ESM-safe resolution (bare __dirname would throw here in dist/cli.mjs). */
export function pdfWorkerEnabled(): boolean {
  if (process.env['PI_RESEARCH_PDF_WORKER'] === 'off') return false;
  return resolveWorkerPath() !== null;
}

function failAllPending(reason: string): void {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.reject(new Error(`PDF worker ${reason}`));
  }
}

function getOrCreatePdfWorker(): Worker | null {
  if (pdfWorker !== null) return pdfWorker;
  const workerPath = resolveWorkerPath();
  if (workerPath === null) {
    if (!warnedWorkerUnavailable) {
      warnedWorkerUnavailable = true;
      logger.warn(
        `[Scrapers] PDF worker bundle absent (${WORKER_FILENAME}) — PDF extraction stays on the main thread this session. ` +
          `Run the build step (npm install / prepare) to regenerate it.`,
      );
    }
    return null;
  }
  let worker: Worker;
  try {
    worker = new Worker(workerPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!warnedWorkerUnavailable) {
      warnedWorkerUnavailable = true;
      logger.warn(`[Scrapers] PDF worker failed to spawn (${msg}) — falling back to in-process extraction.`);
    }
    return null;
  }
  pdfWorker = worker;
  // An idle worker must never keep the process alive at shutdown; there is no
  // browser process to reap and no cleanup ordering to respect (unlike the
  // browser pool), so unref replaces dispose wiring entirely.
  try {
    worker.unref();
  } catch {
    // unref() on a terminating worker can throw on some Node versions — the
    // exit handler below already clears our reference.
  }
  worker.on('message', (msg: { id: number; ok: boolean; markdown?: string; pageCount?: number; kind?: PdfExtractErrorKind; message?: string }) => {
    const pending = pendingRequests.get(msg.id);
    if (pending === undefined) return;
    pendingRequests.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) {
      pending.resolve({ markdown: msg.markdown ?? '', pageCount: msg.pageCount ?? 0 });
    } else {
      pending.reject(new PdfExtractError(msg.kind ?? 'extraction_failed', msg.message ?? 'PDF worker failed'));
    }
  });
  // Crash/exit handlers act only when the dying worker is the CURRENT one: a
  // terminate()-then-respawn sequence can leave the old worker's exit event
  // arriving after a fresh worker was created — without this identity check a
  // stale exit would null the global and fail the NEW worker's requests.
  worker.on('error', (e) => {
    if (pdfWorker === worker) {
      pdfWorker = null;
      failAllPending(`crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  worker.on('exit', (code) => {
    if (pdfWorker === worker) {
      pdfWorker = null;
      failAllPending(`exited (code ${code})`);
    }
  });
  return worker;
}

function extractViaWorkerImpl(bytes: Uint8Array): Promise<PdfParseResult> {
  const worker = getOrCreatePdfWorker();
  if (worker === null) {
    // Absent/spawn-failed worker is NOT a transport failure of a started
    // parse: report it as a plain rejection so the caller falls back cleanly.
    return Promise.reject(new Error('PDF worker unavailable'));
  }
  const id = nextRequestId++;
  // Defensive copy: the transfer neuters the buffer it moves, and while both
  // current call sites never touch pdfBytes after the await, a future caller
  // must not be able to hand itself a detached ArrayBuffer by accident. A
  // one-shot copy of ≤100MB is tens of milliseconds — correctness first.
  const transferable = bytes.slice();
  return new Promise<PdfParseResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The worker instance serving THIS request — terminate that one, never
      // whatever happens to be current when the timer fires.
      const doomed = pendingRequests.get(id)?.worker ?? null;
      // Drop THIS request first so failAllPending below (which rejects every
      // REMAINING pending request and clears their timers) cannot double-fire
      // on it — siblings fail fast instead of hanging out their own 30s.
      pendingRequests.delete(id);
      // A sync wasm parse wedged past the deadline can only be stopped by
      // terminating its thread. The NEXT PDF spawns a fresh worker.
      pdfWorker = null;
      failAllPending(`timed out after ${PDF_WORKER_TIMEOUT_MS}ms`);
      doomed?.terminate().catch(() => undefined);
      reject(new Error(`PDF worker timed out after ${PDF_WORKER_TIMEOUT_MS}ms`));
    }, PDF_WORKER_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer, worker });
    try {
      worker.postMessage({ id, bytes: transferable }, [transferable.buffer]);
    } catch (e) {
      // Synchronous transport failure: this request falls back in-process.
      // Clear the armed timer and the entry, else the timer fires later and
      // terminates whatever worker is CURRENT (an unrelated in-flight parse).
      pendingRequests.delete(id);
      clearTimeout(timer);
      reject(new Error(`PDF worker transport failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

/** Test seam: the orchestration below accepts an injected transport. */
const workerInvoker: WorkerInvoke = extractViaWorkerImpl;

export function disposePdfWorkerPool(): void {
  pdfWorker?.terminate().catch(() => undefined);
  pdfWorker = null;
  failAllPending('disposed');
}

// ============================================================================
// Orchestration — the public surface web-scraper used to define inline.
// ============================================================================

function emitFailure(e: PdfExtractError): void {
  if (e.kind === 'size_exceeded') {
    logger.warn(`[Scrapers] ${e.message}, skipping extraction`);
    metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'size_exceeded' });
    return;
  }
  if (e.kind === 'native_module_unavailable') {
    logger.error(`[Scrapers] pdf-oxide-wasm failed to load — PDF extraction is unavailable (not just for this URL): ${e.cause instanceof Error ? e.cause.message : e.message}`);
    metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'native_module_unavailable' });
    errorTracker.trackError(e.cause instanceof Error ? e.cause : e.message, {
      component: 'scrapers',
      operation: 'pdf-extract',
      contentType: 'pdf',
      errorType: 'native_module_unavailable',
    });
    return;
  }
  // debug, not error: a malformed/encrypted/scanned-image-only PDF is an
  // expected, non-actionable per-URL outcome (see isBenignScrapeFailure).
  logger.debug(`[Scrapers] PDF extraction failed: ${e.cause instanceof Error ? e.cause.message : e.message}`);
  metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'extraction_failed' });
  errorTracker.trackError(e.cause instanceof Error ? e.cause : e.message, {
    component: 'scrapers',
    operation: 'pdf-extract',
    contentType: 'pdf',
    errorType: 'extraction_failed',
  });
}

export async function extractPdfToMarkdown(
  bytes: Uint8Array,
  opts: { invokeWorker?: WorkerInvoke } = {},
): Promise<string> {
  const start = Date.now();
  const invoke = opts.invokeWorker ?? workerInvoker;

  let result: PdfParseResult;
  if (pdfWorkerEnabled()) {
    try {
      result = await invoke(bytes);
    } catch (e) {
      // A CLASSIFIED error is a real answer from inside the worker (size,
      // module, parse): report it, do not redo the work in-process.
      if (e instanceof PdfExtractError) {
        emitFailure(e);
        throw e;
      }
      // Transport failure (spawn/timeout/crash): one bounded in-process
      // retry — today's behavior, still capped by MAX_PDF_SIZE and the
      // scrape deadline.
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[Scrapers] PDF worker path failed (${msg}); retrying extraction in-process`);
      try {
        result = await parsePdfCore(bytes);
      } catch (e2) {
        if (e2 instanceof PdfExtractError) {
          emitFailure(e2);
          throw e2;
        }
        throw e2;
      }
    }
  } else {
    try {
      result = await parsePdfCore(bytes);
    } catch (e) {
      if (e instanceof PdfExtractError) {
        emitFailure(e);
        throw e;
      }
      throw e;
    }
  }

  metrics.observe('scrape_pdf_conversion_ms', Date.now() - start);
  metrics.increment('scrape_pdf_conversions_total', 1, { status: 'success', pages: String(result.pageCount) });
  return result.markdown;
}
