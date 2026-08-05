/**
 * Atomic file replacement, with the Windows caveat handled honestly.
 *
 * The temp-file + fsync + rename dance exists so a reader never observes a partial
 * file and a crash never leaves one: rename is atomic, so the destination is either
 * entirely the old content or entirely the new.
 *
 * On Windows that guarantee is easy to lose. The long-standing comment at these call
 * sites — "fs.rename fails on Windows if target exists (NTFS)" — is not true: Node
 * calls `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, so replacing an existing file
 * is fine. What actually fails is a rename whose TARGET is held open by another
 * process without delete sharing (an AV scanner mid-scan, a backup agent), which
 * surfaces as EPERM/EBUSY/EACCES.
 *
 * The old remedy — fall straight to `copyFile` — traded a transient, retryable error
 * for a permanent hazard: `copyFile` truncates the destination and rewrites it in
 * place, so a concurrent reader or a crash mid-copy sees a torn or zero-length file.
 * For `state.json` (leader election, server auth secrets) and `config.env` (API keys)
 * that is a much worse outcome than the error it was avoiding.
 *
 * So: retry the rename first. An AV lock clears in tens of milliseconds, and a retried
 * rename stays atomic. Only a lock that outlives every retry falls back to copying,
 * which is reported to the caller so it can be logged as the degraded path it is.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';

/** Transient Windows sharing/locking failures — worth retrying, unlike ENOENT/ENOSPC. */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const MAX_RENAME_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 25;

export type ReplaceOutcome = 'renamed' | 'copied';

function isRetryable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && RETRYABLE_CODES.has(code);
}

/**
 * Replace `destPath` with `tmpPath` atomically where the platform allows it.
 *
 * Returns `'renamed'` for the atomic path and `'copied'` for the degraded Windows
 * fallback. Rethrows on every non-Windows failure, and on Windows failures that are
 * not lock-related.
 */
export async function replaceFile(tmpPath: string, destPath: string): Promise<ReplaceOutcome> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt++) {
    try {
      await fs.rename(tmpPath, destPath);
      return 'renamed';
    } catch (err) {
      lastError = err;
      // Only a Windows sharing conflict is worth another try; anything else (and any
      // failure on a POSIX platform, where rename-over-existing always works) is real.
      if (process.platform !== 'win32' || !isRetryable(err)) throw err;
      if (attempt < MAX_RENAME_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  // Every retry lost to the same lock. Copying is not atomic — a reader can catch the
  // destination mid-write — but it is the only remaining way to persist the data.
  try {
    await fs.copyFile(tmpPath, destPath);
    return 'copied';
  } catch {
    throw lastError;
  }
}

/** Synchronous {@link replaceFile}, for the config writer, which is sync throughout. */
export function replaceFileSync(tmpPath: string, destPath: string): ReplaceOutcome {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt++) {
    try {
      fsSync.renameSync(tmpPath, destPath);
      return 'renamed';
    } catch (err) {
      lastError = err;
      if (process.platform !== 'win32' || !isRetryable(err)) throw err;
      if (attempt < MAX_RENAME_ATTEMPTS - 1) {
        // Sync busy-wait: this path is rare, bounded (~250ms worst case) and the
        // caller is already blocking on a synchronous write.
        const until = Date.now() + RENAME_RETRY_DELAY_MS * (attempt + 1);
        while (Date.now() < until) { /* spin */ }
      }
    }
  }

  try {
    fsSync.copyFileSync(tmpPath, destPath);
    return 'copied';
  } catch {
    throw lastError;
  }
}
