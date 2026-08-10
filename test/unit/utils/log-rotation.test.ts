/**
 * LogRotation unit tests.
 *
 * Two invariants matter here beyond basic rotation mechanics:
 *  - Rename failure must SKIP the rotation, never fall back to copy+delete: the
 *    consolidated log is appended to by several processes at once (main,
 *    embedding server, browser workers), and a copy+unlink destroys whatever
 *    they append between the copy and the unlink.
 *  - Rotation and clearLogs must recreate the live log at 0o600: Logger
 *    pre-creates it owner-only because the default path sits in a
 *    world-traversable tmpdir, and a umask-default recreate by the next append
 *    would silently drop that posture.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const mockState = vi.hoisted(() => ({ failRename: false, raceRecreate: false }));

// Pass-through fs mock: only renameSync is interceptable, so every other call in
// both the module under test and this file hits the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (mockState.failRename) {
        const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      const result = actual.renameSync(oldPath, newPath);
      if (mockState.raceRecreate) {
        // Interleave the hazard under test: a concurrent process's async append
        // lands between the rename and the 0o600 recreate, materializing the
        // live log at umask-default perms (chmod pins them umask-independently).
        actual.writeFileSync(oldPath, 'concurrent append\n');
        actual.chmodSync(oldPath, 0o644);
      }
      return result;
    }) as typeof actual.renameSync,
  };
});

let LogRotation: (typeof import('../../../src/utils/log-rotation.ts'))['LogRotation'];
let touchOwnerOnly: (typeof import('../../../src/utils/log-rotation.ts'))['touchOwnerOnly'];

beforeAll(async () => {
  // The unit-test setup file loads src/utils/metrics.ts → logger.ts →
  // log-rotation.ts BEFORE this file's vi.mock('node:fs') registration, so a
  // static import would hand back the cached instance bound to the REAL fs and
  // the rename interception above would never fire. Re-evaluating the module
  // after resetModules resolves its node:fs import through the mock registry.
  vi.resetModules();
  ({ LogRotation, touchOwnerOnly } = await import('../../../src/utils/log-rotation.ts'));
});

// One byte over the class's 10MB cap so a rotation check fires.
const OVERSIZE = 10 * 1024 * 1024 + 1;

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    log: (...args: unknown[]) => { lines.push(args.map(String).join(' ')); },
  };
}

describe('LogRotation', () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    mockState.failRename = false;
    mockState.raceRecreate = false;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-log-rotation-test-'));
    logFile = path.join(dir, 'research-debug.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotates an oversized file and recreates the live log empty and owner-only (0600)', () => {
    fs.writeFileSync(logFile, Buffer.alloc(OVERSIZE, 0x61));
    const logger = recordingLogger();

    new LogRotation(logger).rotateLogFile(logFile, dir);

    const archives = fs.readdirSync(dir).filter((f) => f.startsWith('research-debug.log.'));
    expect(archives).toHaveLength(1);
    // The archive carries the full pre-rotation content.
    expect(fs.statSync(path.join(dir, archives[0]!)).size).toBe(OVERSIZE);
    // The live log is recreated empty so concurrent appenders inherit the
    // owner-only file instead of materializing a umask-default one.
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.statSync(logFile).size).toBe(0);
    if (process.platform !== 'win32') {
      expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    }
  });

  it('skips rotation when rename fails, preserving the source file intact', () => {
    fs.writeFileSync(logFile, Buffer.alloc(OVERSIZE, 0x61));
    mockState.failRename = true;
    const logger = recordingLogger();

    new LogRotation(logger).rotateLogFile(logFile, dir);

    // The source must be untouched — a copy+delete fallback would drop appends
    // other processes land between the copy and the unlink.
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.statSync(logFile).size).toBe(OVERSIZE);
    const archives = fs.readdirSync(dir).filter((f) => f.startsWith('research-debug.log.'));
    expect(archives).toHaveLength(0);
    expect(logger.lines.join('\n')).toContain('Log rotation skipped');
  });

  it('re-stamps 0600 when a concurrent append recreates the log between rename and recreate', () => {
    // chmod is advisory on win32 and this asserts POSIX modes.
    if (process.platform === 'win32') return;
    fs.writeFileSync(logFile, Buffer.alloc(OVERSIZE, 0x61));
    mockState.raceRecreate = true;

    new LogRotation(recordingLogger()).rotateLogFile(logFile, dir);

    // Mode applies only at creation, so without the explicit post-recreate chmod
    // the racy 0644 file persists indefinitely in a world-traversable tmpdir.
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    // The concurrent append's data survives: the recreate opens append-mode.
    expect(fs.readFileSync(logFile, 'utf8')).toContain('concurrent append');
  });

  it('leaves a file under the size cap alone', () => {
    fs.writeFileSync(logFile, 'small');

    new LogRotation(recordingLogger()).rotateLogFile(logFile, dir);

    expect(fs.readFileSync(logFile, 'utf8')).toBe('small');
    expect(fs.readdirSync(dir)).toEqual(['research-debug.log']);
  });

  it('clearLogs removes archives and recreates the live log empty and owner-only (0600)', () => {
    fs.writeFileSync(logFile, 'live content');
    fs.writeFileSync(`${logFile}.2026-01-01T00-00-00-000Z`, 'old archive');
    const logger = recordingLogger();

    new LogRotation(logger).clearLogs(logFile, dir);

    expect(fs.readdirSync(dir)).toEqual(['research-debug.log']);
    expect(fs.statSync(logFile).size).toBe(0);
    if (process.platform !== 'win32') {
      expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    }
  });

  it('touchOwnerOnly refuses to follow a symlink planted at the target path', () => {
    // O_NOFOLLOW is not enforced on Windows — the hardening is POSIX-only.
    if (process.platform === 'win32') return;
    const real = path.join(dir, 'someone-elses-file.txt');
    fs.writeFileSync(real, 'do-not-touch', { mode: 0o644 });
    const linkPath = path.join(dir, 'log.txt');
    fs.symlinkSync(real, linkPath);

    touchOwnerOnly(linkPath, 0o600);

    // A naive open('a') would have followed the link and re-stamped 0600 on
    // someone else's file. The symlink itself must be left exactly as it was.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('do-not-touch');
    expect(fs.statSync(real).mode & 0o777).toBe(0o644);
  });
});
