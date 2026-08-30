/**
 * PDF extraction module — orchestration, classified-error contract, and the
 * worker-transport fallback seam.
 *
 * The in-process parse core is shared with web-scraper's legacy tests
 * (scrapers.test.ts) via the same vi.mock('pdf-oxide-wasm') seam; those
 * contracts are NOT re-asserted here. This file covers what moved or changed:
 * the orchestration wrapper (metrics parity, fallback policy) and the
 * injected worker transport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractPdfToMarkdown,
  parsePdfCore,
  PdfExtractError,
} from '../../../src/web-research/pdf-extraction.ts';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const pdfMockState = vi.hoisted(() => ({ lastBytes: null as Uint8Array | null, freeCalls: 0 }));
vi.mock('pdf-oxide-wasm', () => {
  return {
    WasmPdfDocument: class {
      constructor(bytes: Uint8Array) {
        pdfMockState.lastBytes = bytes;
        if (bytes.length === 0) throw new Error('empty or corrupt PDF buffer');
      }
      pageCount = () => 2;
      toMarkdown = (i: number) => `page ${i}`;
      toMarkdownAll = () => 'all pages content';
      free = () => { pdfMockState.freeCalls++; };
    },
  };
});

const VALID_BYTES = () => new TextEncoder().encode('%PDF-1.4 minimal');

describe('parsePdfCore (in-process core, shared with the worker entry)', () => {
  beforeEach(() => {
    pdfMockState.lastBytes = null;
    pdfMockState.freeCalls = 0;
    delete process.env['PI_RESEARCH_PDF_WORKER'];
    // The unit setup default keeps the worker path off; make it explicit here
    // so these core tests never depend on bundle presence.
    process.env['PI_RESEARCH_PDF_WORKER'] = 'off';
  });

  it('returns the historical markdown shape and frees the document', async () => {
    const md = await extractPdfToMarkdown(VALID_BYTES());
    expect(md).toContain('# PDF Document');
    expect(md).toContain('**Pages:** 2');
    expect(md).toContain('all pages content');
    expect(pdfMockState.freeCalls).toBe(1);
    expect(pdfMockState.lastBytes).not.toBeNull();
  });

  it('preserves the benign per-URL extraction-failure string byte-identically', async () => {
    await expect(parsePdfCore(new Uint8Array(0))).rejects.toThrow(
      'Could not extract content from PDF (empty or corrupt PDF buffer)',
    );
    // free() must still have run for the throwing constructor path? The
    // constructor threw before `doc` was assigned, so there is nothing to
    // free — the guard is the try/finally around usage, not construction.
    expect(pdfMockState.freeCalls).toBe(0);
  });

  it('classifies parse failures with the kind that survives the worker hop', async () => {
    const p = parsePdfCore(new Uint8Array(0));
    await expect(p).rejects.toBeInstanceOf(PdfExtractError);
    await p.catch((e: PdfExtractError) => {
      expect(e.kind).toBe('extraction_failed');
    });
  });
});

describe('extractPdfToMarkdown orchestration (injected transport)', () => {
  beforeEach(() => {
    process.env['PI_RESEARCH_PDF_WORKER'] = 'off';
    pdfMockState.lastBytes = null;
  });

  it('worker disabled → in-process core runs (mock seam reaches the parse)', async () => {
    const md = await extractPdfToMarkdown(VALID_BYTES());
    expect(md).toContain('all pages content');
  });

  it('transport failure falls back to one in-process parse', async () => {
    process.env['PI_RESEARCH_PDF_WORKER'] = 'on';
    const boom = async () => {
      throw new Error('PDF worker timed out after 30000ms');
    };
    const md = await extractPdfToMarkdown(VALID_BYTES(), { invokeWorker: boom });
    expect(md).toContain('all pages content');
  });

  it('classified error from the worker is a real answer — no in-process retry', async () => {
    process.env['PI_RESEARCH_PDF_WORKER'] = 'on';
    pdfMockState.lastBytes = null; // stays null if (and only if) no fallback parse ran
    const classified = async () => {
      throw new PdfExtractError('size_exceeded', 'PDF too large (101MB, max 100MB)');
    };
    await expect(extractPdfToMarkdown(VALID_BYTES(), { invokeWorker: classified })).rejects.toThrow(
      'PDF too large (101MB, max 100MB)',
    );
    expect(pdfMockState.lastBytes).toBeNull();
  });

  it('worker success short-circuits the in-process parse', async () => {
    process.env['PI_RESEARCH_PDF_WORKER'] = 'on';
    pdfMockState.lastBytes = null;
    const viaWorker = async () => ({ markdown: '# PDF Document\n\n**Pages:** 9\n\nfrom worker', pageCount: 9 });
    const md = await extractPdfToMarkdown(VALID_BYTES(), { invokeWorker: viaWorker });
    expect(md).toContain('from worker');
    expect(pdfMockState.lastBytes).toBeNull();
  });
});

describe('real worker bundle (built artifact)', () => {
  it(
    'round-trips a parse through the actual worker when the bundle exists',
    async () => {
      const bundle = join(process.cwd(), 'src/web-research/pdf-extract-worker.mjs');
      if (!existsSync(bundle)) {
        console.warn('pdf-extract-worker.mjs not built — skipping live worker round-trip');
        return;
      }
      process.env['PI_RESEARCH_PDF_WORKER'] = 'on';
      // The worker is a REAL process: the vi.mock above does not apply inside
      // it. A zero-byte buffer therefore produces the genuine wasm parser's
      // failure — classified 'extraction_failed' with the benign string.
      await expect(extractPdfToMarkdown(new Uint8Array(0))).rejects.toThrow(
        /Could not extract content from PDF|PDF extraction unavailable/,
      );
    },
    60_000,
  );
});
