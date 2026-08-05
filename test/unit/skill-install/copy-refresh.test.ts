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
});
