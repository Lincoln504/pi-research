/**
 * captureStdio — restore ordering.
 *
 * Keyed captures nest by design (a research run's capture around the embedding
 * server's init capture), and nothing orders their exits: a cancelled run's
 * OUTER capture routinely finishes while the nested one is still in flight.
 * Each capture saves the currently-installed writers as its "originals", so an
 * eager per-frame restore re-installs a dead capture's patch closures when the
 * straggler finally exits — permanently diverting stdout/stderr/console into
 * the log file. These tests pin the lazy-LIFO unwind that prevents that.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureStdio } from '../../../src/utils/stdio-capture.ts';

function tmpLogFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-cap-test-')), 'log.jsonl');
}

describe('captureStdio — LIFO restore under out-of-order completion', () => {
  it('restores the true originals only after the LAST nested capture finishes', async () => {
    const logFile = tmpLogFile();
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    const origLog = console.log;

    let releaseInner!: () => void;
    const innerGate = new Promise<void>((r) => { releaseInner = r; });
    let innerDone!: Promise<void>;

    await captureStdio(logFile, () => true, async () => {
      // Nested keyed capture that OUTLIVES the outer one.
      innerDone = captureStdio(logFile, () => true, async () => { await innerGate; }, 'lifo-inner');
    }, 'lifo-outer');

    // Outer finished out of order: nothing may be restored yet — an eager
    // restore here is exactly what left stdio pointing at a dead capture.
    expect(process.stdout.write).not.toBe(origStdout);

    releaseInner();
    await innerDone;

    expect(process.stdout.write).toBe(origStdout);
    expect(process.stderr.write).toBe(origStderr);
    expect(console.log).toBe(origLog);
  });

  it('in-order nesting still restores immediately at each exit', async () => {
    const logFile = tmpLogFile();
    const origStdout = process.stdout.write;

    await captureStdio(logFile, () => true, async () => {
      await captureStdio(logFile, () => true, async () => {
        expect(process.stdout.write).not.toBe(origStdout);
      }, 'inorder-inner');
      // Inner exited while it was the top frame — outer's patches are back.
      expect(process.stdout.write).not.toBe(origStdout);
    }, 'inorder-outer');

    expect(process.stdout.write).toBe(origStdout);
  });
});
