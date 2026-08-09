/**
 * installSkill()'s stale-symlink re-point path vs. a symlinkSync failure
 * AFTER the old link was already removed.
 *
 * Regression: `fs.unlinkSync(absSkillPath)` runs first, then
 * `fs.symlinkSync(source, absSkillPath, ...)`. If the unlink succeeds but
 * the symlink call then throws — e.g. a Windows junction cannot cross
 * volumes, and `pi update` can relocate the package to a different drive —
 * the error used to escape to the OUTER catch (`/* fall through to
 * already-installed below *​/`), which reported success even though
 * absSkillPath no longer existed on disk AT ALL. The fresh-install path
 * already has a copy-fallback for this exact symlinkSync failure; the
 * re-point path needed the same one.
 *
 * Mocks only `fs.symlinkSync` (conditionally, via a controllable flag) —
 * every other fs call goes to a REAL tmpdir, so this is an end-to-end test
 * of the actual re-point control flow, not a unit test against a fully
 * mocked filesystem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { symlinkFailure } = vi.hoisted(() => ({ symlinkFailure: { active: false } }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (symlinkFailure.active) {
        const err: any = new Error('EXDEV: cross-device link not permitted, symlink');
        err.code = 'EXDEV';
        throw err;
      }
      return actual.symlinkSync(...args);
    },
  };
});

import { installSkill } from '../../../src/skill-install/skill-installer.ts';

const PACKAGE_NAME = '@lincoln504/pi-research';

let home: string;
let sourceDir: string;

function writeSource(dir: string, version: string, marker = 'ORIGINAL'): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: pi-research\nmetadata: { "package": "${PACKAGE_NAME}", "version": "${version}" }\n---\n\n# ${marker}\n`,
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'run.mjs'), `// ${marker}\n`);
}

beforeEach(() => {
  symlinkFailure.active = false;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-home-'));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-src-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
});

afterEach(() => {
  symlinkFailure.active = false;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

describe('installSkill — symlink re-point vs. a symlinkSync failure', () => {
  it('falls back to a copy instead of leaving the skill missing when the re-point symlinkSync throws', () => {
    writeSource(sourceDir, '1.0.0', 'ORIGINAL');
    installSkill(['claude'], { home, skillSourceDir: sourceDir }); // symlink mode

    const target = path.join(home, '.claude', 'skills', 'pi-research');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

    // Package relocated (e.g. by an update) — the link is now stale.
    const movedSource = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-moved-'));
    try {
      writeSource(movedSource, '1.1.0', 'RELOCATED');

      // The re-point's symlinkSync call fails AFTER the old link is unlinked.
      symlinkFailure.active = true;
      const results = installSkill(['claude'], { home, skillSourceDir: movedSource });
      symlinkFailure.active = false;

      // Never left missing: the old behavior deleted the link and then
      // silently reported 'already-installed' with nothing on disk.
      expect(fs.existsSync(target)).toBe(true);
      expect(results[0]!.status).toBe('installed');
      expect(results[0]!.type).toBe('copy');
      expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toContain('RELOCATED');
    } finally {
      fs.rmSync(movedSource, { recursive: true, force: true });
    }
  });
});
