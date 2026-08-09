/**
 * Copy-mode skill installs must track the package across upgrades.
 *
 * A symlink re-reads the package on every use, so it is always current. A COPY is
 * a point-in-time snapshot, and reconcile skipped non-symlinks entirely while the
 * manifest recorded no version — so drift was undetectable by construction and a
 * copy-installed user kept the SKILL.md their engine shipped with indefinitely,
 * including its exit-code contract, while the engine underneath them changed.
 *
 * Copies are not an edge case: Windows without symlink privilege, cross-device
 * installs, `--copy`, and the documented OpenClaw route all produce them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installSkill, reconcileSkillInstalls } from '../../../src/skill-install/skill-installer.ts';

const PACKAGE_NAME = '@lincoln504/pi-research';

let home: string;
let sourceDir: string;

/** Build a fake skill source dir carrying `version` in its SKILL.md metadata. */
function writeSource(dir: string, version: string, marker = 'ORIGINAL'): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: pi-research\nmetadata: { "package": "${PACKAGE_NAME}", "version": "${version}" }\n---\n\n# ${marker}\n`,
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'run.mjs'), `// ${marker}\n`);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-home-'));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-src-'));
  // The installer only offers targets whose config dir already exists.
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

const installedSkillMd = () =>
  fs.readFileSync(path.join(home, '.claude', 'skills', 'pi-research', 'SKILL.md'), 'utf-8');

describe('reconcileSkillInstalls — copy freshness', () => {
  it('refreshes an owned copy when the package version has moved on', () => {
    writeSource(sourceDir, '1.0.0', 'OLD-CONTRACT');
    installSkill(['claude'], { home, skillSourceDir: sourceDir, copy: true });
    expect(installedSkillMd()).toContain('OLD-CONTRACT');

    // Engine upgraded underneath the copy — this is the case that used to leave
    // the user on the previous exit-code contract forever.
    writeSource(sourceDir, '1.1.0', 'NEW-CONTRACT');

    const result = reconcileSkillInstalls({ home, skillSourceDir: sourceDir });

    expect(result.refreshed).toHaveLength(1);
    expect(installedSkillMd()).toContain('NEW-CONTRACT');
    expect(installedSkillMd()).toContain('"version": "1.1.0"');
    // The whole tree is replaced, not just SKILL.md.
    expect(
      fs.readFileSync(path.join(home, '.claude', 'skills', 'pi-research', 'scripts', 'run.mjs'), 'utf-8'),
    ).toContain('NEW-CONTRACT');
  });

  it('leaves a copy alone when the version is unchanged (no needless churn)', () => {
    writeSource(sourceDir, '1.1.0');
    installSkill(['claude'], { home, skillSourceDir: sourceDir, copy: true });

    const result = reconcileSkillInstalls({ home, skillSourceDir: sourceDir });

    expect(result.refreshed).toEqual([]);
  });

  it('refreshes a legacy entry that predates version stamping', () => {
    writeSource(sourceDir, '1.0.0', 'OLD-CONTRACT');
    installSkill(['claude'], { home, skillSourceDir: sourceDir, copy: true });

    // Simulate a manifest written before `version` existed.
    const manifestPath = path.join(home, '.pi', 'research', 'installed-skills.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const e of manifest.entries) delete e.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    writeSource(sourceDir, '1.1.0', 'NEW-CONTRACT');
    const result = reconcileSkillInstalls({ home, skillSourceDir: sourceDir });

    expect(result.refreshed).toHaveLength(1);
    expect(installedSkillMd()).toContain('NEW-CONTRACT');
  });

  it('never overwrites a FOREIGN directory sitting at the tracked path', () => {
    writeSource(sourceDir, '1.0.0');
    installSkill(['claude'], { home, skillSourceDir: sourceDir, copy: true });

    // User replaced our copy with an unrelated skill of the same name.
    const target = path.join(home, '.claude', 'skills', 'pi-research');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: someone-elses-skill\n---\n');

    writeSource(sourceDir, '1.1.0');
    const result = reconcileSkillInstalls({ home, skillSourceDir: sourceDir });

    expect(result.refreshed).toEqual([]);
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toContain('someone-elses-skill');
  });

  it('leaves a usable install behind even when the recorded source dir has vanished', () => {
    writeSource(sourceDir, '1.0.0', 'ORIGINAL');
    installSkill(['claude'], { home, skillSourceDir: sourceDir, copy: true });

    // The dir the copy came from is gone (package relocated by an upgrade, temp
    // build dir cleaned up). resolveSkillSourceDir falls back to the real bundled
    // skill rather than failing, so a refresh can still proceed — the property
    // that matters is that the user is never left with a DESTROYED install, which
    // is what a remove-then-copy sequence risks if the source were unusable.
    fs.rmSync(sourceDir, { recursive: true, force: true });
    reconcileSkillInstalls({ home, skillSourceDir: sourceDir });

    const target = path.join(home, '.claude', 'skills', 'pi-research');
    expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(true);
    expect(installedSkillMd()).toContain(PACKAGE_NAME);
  });

  it('a refresh whose COPY fails leaves the old install intact and retries next startup', () => {
    // The rm-then-copy shape destroyed the install permanently here: rmSync ran
    // first, copyDir threw (unreadable source, ENOSPC), and the retry guard
    // requires the path to EXIST — so the vanished install was never retried.
    // Build-then-swap must not touch the live tree until the new one is ready.
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      return; // chmod-based unreadability is not enforceable here
    }
    writeSource(sourceDir, '1.0.0', 'ORIGINAL');
    installSkill(['claude'], { home, skillSourceDir: sourceDir, copy: true });

    writeSource(sourceDir, '1.1.0', 'NEW');
    // Version stays readable (staleness is detected) but the tree cannot be
    // copied: scripts/ is unreadable, so copyDir throws mid-walk.
    fs.chmodSync(path.join(sourceDir, 'scripts'), 0o000);
    try {
      const result = reconcileSkillInstalls({ home, skillSourceDir: sourceDir });
      expect(result.refreshed).toEqual([]);
    } finally {
      fs.chmodSync(path.join(sourceDir, 'scripts'), 0o755);
    }

    // The install the user had is byte-for-byte still there...
    expect(installedSkillMd()).toContain('ORIGINAL');
    // ...no staging debris a skill scanner could mistake for a skill...
    const skillsDir = path.join(home, '.claude', 'skills');
    expect(fs.readdirSync(skillsDir)).toEqual(['pi-research']);
    // ...and the manifest entry survives, so the NEXT startup retries and wins.
    const retry = reconcileSkillInstalls({ home, skillSourceDir: sourceDir });
    expect(retry.refreshed).toHaveLength(1);
    expect(installedSkillMd()).toContain('NEW');
  });

  it('an ordinary re-install re-run does NOT launder the manifest version for an unrefreshed copy', () => {
    // installSkill's "already-installed" branch takes no action for an
    // existing owned COPY (no re-copy happens) — but it used to still stamp
    // the manifest entry's `version` to the CURRENT package version anyway.
    // reconcileSkillInstalls' staleness check compares e.version against the
    // current version, so that false stamp permanently defeated it: the
    // entry looked "current" forever even though the on-disk copy was never
    // actually refreshed.
    writeSource(sourceDir, '1.0.0', 'OLD-CONTRACT');
    installSkill(['claude'], { home, skillSourceDir: sourceDir, copy: true });

    // Engine upgraded underneath the copy, and something calls installSkill
    // again ordinarily (e.g. a re-run of `pi skill install`) — NOT a fresh
    // install, since the copy is already present.
    writeSource(sourceDir, '1.1.0', 'NEW-CONTRACT');
    const reinstall = installSkill(['claude'], { home, skillSourceDir: sourceDir, copy: true });
    expect(reinstall[0]!.status).toBe('already-installed');

    // The on-disk copy must be untouched (this branch takes no copy action)...
    expect(installedSkillMd()).toContain('OLD-CONTRACT');
    // ...and the manifest must NOT have been laundered to claim it's current.
    const manifestPath = path.join(home, '.pi', 'research', 'installed-skills.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const entry = manifest.entries.find((e: any) => e.path.includes('pi-research'));
    expect(entry.version).not.toBe('1.1.0');

    // The staleness check must still correctly fire and actually refresh it.
    const result = reconcileSkillInstalls({ home, skillSourceDir: sourceDir });
    expect(result.refreshed).toHaveLength(1);
    expect(installedSkillMd()).toContain('NEW-CONTRACT');
  });

  it('honours dryRun for the stale-symlink re-point (plan only, touch nothing)', () => {
    writeSource(sourceDir, '1.0.0');
    installSkill(['claude'], { home, skillSourceDir: sourceDir }); // symlink mode

    // Relocate the package: the owned link now points at a stale path.
    const movedSource = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-moved-'));
    try {
      writeSource(movedSource, '1.1.0');
      const linkPath = path.join(home, '.claude', 'skills', 'pi-research');
      const before = fs.readlinkSync(linkPath);

      const results = installSkill(['claude'], { home, skillSourceDir: movedSource, dryRun: true });

      expect(results[0]!.status).toBe('planned');
      expect(fs.readlinkSync(linkPath)).toBe(before); // untouched
    } finally {
      fs.rmSync(movedSource, { recursive: true, force: true });
    }
  });
});
