/**
 * reconcileSkillInstalls()'s symlink re-point copy-fallback must sweep
 * orphaned `.{base}.new-*` staging leftovers from a previous crashed attempt
 * at the same path.
 *
 * Regression: the fallback (fs.symlinkSync failed after the old link was
 * already unlinked) stages a fresh copy into a dot-prefixed temp dir and
 * fs.renameSync's it into place. If the process is killed after copyDir
 * succeeds but before that renameSync runs, the temp dir is left on disk —
 * and unlike the sibling copy-refresh branch (which sweeps its own `.new-*`/
 * `.old-*` leftovers before starting a new swap), nothing here ever revisited
 * or cleaned up `.new-*` names for the symlink path, so repeated failures
 * would accumulate orphaned directories indefinitely.
 *
 * Mocks only `fs.symlinkSync` (conditionally) — every other fs call goes to a
 * REAL tmpdir, matching the sibling symlink-repoint-failure.test.ts.
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

import { installSkill, reconcileSkillInstalls } from '../../../src/skill-install/skill-installer.ts';

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

describe('reconcileSkillInstalls — symlink re-point copy-fallback staging sweep', () => {
  it('sweeps a `.new-*` leftover from a previous crashed re-point attempt before staging a new one', () => {
    // reconcileSkillInstalls' ownership check calls isOwnedSymlink(e.path)
    // with NO expectedSource, so it falls back to matching the dest path
    // shape (…/pi-research/skills/pi-research) rather than an exact-source
    // comparison — the source dirs must have that exact layout for the
    // symlink to be recognized as ours at all.
    const packagedSourceDir = path.join(sourceDir, 'pi-research', 'skills', 'pi-research');
    writeSource(packagedSourceDir, '1.0.0', 'ORIGINAL');
    installSkill(['claude'], { home, skillSourceDir: packagedSourceDir }); // symlink mode

    const target = path.join(home, '.claude', 'skills', 'pi-research');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

    // Simulate a crash left over from a PRIOR re-point attempt at this exact
    // path: a stale staging dir with garbage content (not even a real skill).
    const leftover = path.join(home, '.claude', 'skills', '.pi-research.new-deadbeef');
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'partial-junk'), 'incomplete copy from a killed process');

    // Package relocated (e.g. by an update) — the link is now stale.
    const movedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-moved-'));
    const movedSource = path.join(movedBase, 'pi-research', 'skills', 'pi-research');
    try {
      writeSource(movedSource, '1.1.0', 'RELOCATED');

      // Force the re-point down the copy-fallback branch.
      symlinkFailure.active = true;
      const result = reconcileSkillInstalls({ home, skillSourceDir: movedSource });
      symlinkFailure.active = false;

      expect(result.repointed).toHaveLength(1);
      expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toContain('RELOCATED');

      // The old crash leftover is gone, and no fresh `.new-*` staging dir was
      // left behind by THIS successful attempt either — the skills dir has
      // exactly the one real, named entry.
      expect(fs.existsSync(leftover)).toBe(false);
      const skillsDir = path.join(home, '.claude', 'skills');
      expect(fs.readdirSync(skillsDir)).toEqual(['pi-research']);
    } finally {
      fs.rmSync(movedBase, { recursive: true, force: true });
    }
  });
});
