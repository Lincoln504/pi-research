/**
 * stealStaleLock — ABA-restore race behaviour.
 *
 * The steal path's race windows (a contender's O_EXCL create landing between our
 * renameSync and the linkSync restore) cannot be interleaved through the public
 * saveConfig/updateProjectSettingsRegistry API — the code is synchronous with no
 * yield points — so these tests drive the exported seam directly and inject the
 * contender inside a linkSync hook, producing the EXACT EEXIST the production
 * race produces.
 *
 * Regression under test: after renaming away a lock that turned out FRESH (ABA),
 * a failed linkSync restore fell through to unlinkSync(reclaimPath) — permanently
 * destroying the displaced fresh lock's inode. The fix leaves the reclaim file in
 * place (one stale file, swept age-gated at the next steal) instead of erasing a
 * live holder's lock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

const linkHook = vi.hoisted(() => ({
  impl: null as null | ((existing: string, next: string) => void),
}));

// Pass-through mock of node:fs with an interceptable linkSync, so a test can
// make a contender's lock appear at lockPath at the exact moment production
// would try the restore. Everything else hits the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: (existing: any, next: any) => {
      if (linkHook.impl) return linkHook.impl(String(existing), String(next));
      return actual.linkSync(existing, next);
    },
  };
});

import * as fs from 'node:fs';
import { _stealStaleLockForTests } from '../../src/config.ts';

const fsActual = await vi.importActual<typeof import('node:fs')>('node:fs');

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = fsActual.mkdtempSync(path.join(os.tmpdir(), 'pir-steal-'));
  lockPath = path.join(dir, 'registry.json.lock');
});
afterEach(() => {
  linkHook.impl = null;
  fsActual.rmSync(dir, { recursive: true, force: true });
});

/** Reclaim files this steal (or a previous one) left in the lock's directory. */
function reclaimFiles(): string[] {
  return fsActual.readdirSync(dir).filter((n) => n.startsWith('registry.json.lock.stale-'));
}

/**
 * Set up the ABA scene: stat a stale lock A, then replace it at lockPath with a
 * FRESH lock B belonging to a live holder. A's inode is parked under another
 * name so B is guaranteed a different inode (no reuse).
 */
function abaScene(): { judgedStale: fs.Stats } {
  fsActual.writeFileSync(lockPath, 'stale-A', 'utf-8');
  const judgedStale = fsActual.statSync(lockPath);
  fsActual.renameSync(lockPath, path.join(dir, 'parked-A')); // keeps A's inode alive
  fsActual.writeFileSync(lockPath, 'fresh-B', 'utf-8');
  return { judgedStale };
}

describe('stealStaleLock — ABA restore', () => {
  it('EEXIST on the restore leaves the displaced fresh lock inode in place (never unlinks it)', () => {
    const { judgedStale } = abaScene();
    // The contender wins the path race between our rename and our restore: it
    // creates a brand-new lock at lockPath, so the real linkSync throws EEXIST.
    linkHook.impl = (existing, next) => {
      fsActual.writeFileSync(next, 'contender-C', 'utf-8');
      fsActual.linkSync(existing, next); // → EEXIST, exactly as in production
    };

    _stealStaleLockForTests(lockPath, judgedStale);

    // The contender's lock survives untouched…
    expect(fsActual.readFileSync(lockPath, 'utf-8')).toBe('contender-C');
    // …and the displaced FRESH lock (B) is preserved under its reclaim name —
    // pre-fix it was unconditionally unlinked here.
    const leftovers = reclaimFiles();
    expect(leftovers).toHaveLength(1);
    expect(fsActual.readFileSync(path.join(dir, leftovers[0]!), 'utf-8')).toBe('fresh-B');
  });

  it('a successful ABA restore puts the fresh lock back and removes the reclaim name', () => {
    const { judgedStale } = abaScene();
    _stealStaleLockForTests(lockPath, judgedStale);
    expect(fsActual.readFileSync(lockPath, 'utf-8')).toBe('fresh-B');
    expect(reclaimFiles()).toHaveLength(0);
  });

  it('a genuine stale steal removes the lock and leaves no reclaim files', () => {
    fsActual.writeFileSync(lockPath, 'stale-A', 'utf-8');
    const judgedStale = fsActual.statSync(lockPath);
    _stealStaleLockForTests(lockPath, judgedStale);
    expect(fsActual.existsSync(lockPath)).toBe(false);
    expect(reclaimFiles()).toHaveLength(0);
  });

  it('sweeps OLD leftover reclaim files at steal time, but never a recent one', () => {
    // A leftover from a previous failed restore, well past the sweep age…
    const oldReclaim = path.join(dir, 'registry.json.lock.stale-1-1');
    fsActual.writeFileSync(oldReclaim, 'ancient', 'utf-8');
    const past = new Date(Date.now() - 10 * 60 * 1000);
    fsActual.utimesSync(oldReclaim, past, past);
    // …and a RECENT one another contender may still be inspecting mid-steal.
    const youngReclaim = path.join(dir, 'registry.json.lock.stale-2-2');
    fsActual.writeFileSync(youngReclaim, 'in-flight', 'utf-8');

    fsActual.writeFileSync(lockPath, 'stale-A', 'utf-8');
    const judgedStale = fsActual.statSync(lockPath);
    _stealStaleLockForTests(lockPath, judgedStale);

    expect(fsActual.existsSync(oldReclaim)).toBe(false);
    expect(fsActual.existsSync(youngReclaim)).toBe(true);
  });
});
