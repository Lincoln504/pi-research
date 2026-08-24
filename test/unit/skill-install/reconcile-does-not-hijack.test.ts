/**
 * reconcileSkillInstalls() must not steal a HEALTHY skill link from another install.
 *
 * Regression, observed in the wild: reconcile runs on every engine-touching CLI
 * invocation, resolving its source from whichever copy of the package is being
 * invoked. It used to re-point any owned link whose destination differed from that
 * source — so a second, entirely ordinary install captured the user's skill links
 * merely by being run once.
 *
 * That is a documented setup, not an exotic one: docs/SDK.md instructs users to
 * `npm install @lincoln504/pi-research` INTO their project so the SDK imports
 * resolve. Anything that then ran that project-local CLI (an npm script, npx, a
 * health check) silently moved the user's GLOBAL Claude/OpenClaw skill link into
 * the project directory. When the project was later moved, cleaned or deleted, the
 * skill died with an opaque "Cannot find module .../scripts/run.mjs" — while
 * `skill status` still reported it installed.
 *
 * Self-healing only ever needed the dangling case, which is what an update that
 * relocates the package actually produces. Choosing between two LIVE installs is
 * what the explicit `pi-research skill install` is for.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installSkill, reconcileSkillInstalls } from '../../../src/skill-install/skill-installer.ts';

const PACKAGE_NAME = '@lincoln504/pi-research';

let home: string;
let globalBase: string;
let projectBase: string;

/** The layout isOwnedSymlink() matches on: …/pi-research/agent-skill/pi-research */
function makeInstall(base: string, version: string, marker: string): string {
  const dir = path.join(base, 'pi-research', 'agent-skill', 'pi-research');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: pi-research\nmetadata: { "package": "${PACKAGE_NAME}", "version": "${version}" }\n---\n\n# ${marker}\n`,
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'run.mjs'), `// ${marker}\n`);
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-hijack-home-'));
  globalBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-hijack-global-'));
  projectBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-hijack-project-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
});

afterEach(() => {
  for (const d of [home, globalBase, projectBase]) fs.rmSync(d, { recursive: true, force: true });
});

describe('reconcileSkillInstalls — a second install must not capture the link', () => {
  it('leaves a healthy link pointing at the install the user chose', () => {
    const globalSource = makeInstall(globalBase, '1.6.1', 'GLOBAL');
    installSkill(['claude'], { home, skillSourceDir: globalSource });

    const target = path.join(home, '.claude', 'skills', 'pi-research');
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(globalSource));

    // A project-local copy runs the CLI once. Reconcile fires with ITS source.
    const projectSource = makeInstall(projectBase, '1.6.1', 'PROJECT');
    const result = reconcileSkillInstalls({ home, skillSourceDir: projectSource });

    expect(result.repointed).toEqual([]);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(globalSource));
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toContain('GLOBAL');
  });

  it('survives the project install being deleted afterwards', () => {
    // The failure this prevents: the link had been moved into the project, and
    // removing the project left the user with a dangling link and a dead skill.
    const globalSource = makeInstall(globalBase, '1.6.1', 'GLOBAL');
    installSkill(['claude'], { home, skillSourceDir: globalSource });
    const target = path.join(home, '.claude', 'skills', 'pi-research');

    const projectSource = makeInstall(projectBase, '1.6.1', 'PROJECT');
    reconcileSkillInstalls({ home, skillSourceDir: projectSource });
    fs.rmSync(projectBase, { recursive: true, force: true });

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(path.join(target, 'scripts', 'run.mjs'))).toBe(true);
  });

  it('still heals a link whose target is genuinely gone', () => {
    // The case reconcile exists for: an update relocated the package, so the old
    // target no longer exists and the link must follow the package.
    const oldSource = makeInstall(globalBase, '1.6.0', 'OLD');
    installSkill(['claude'], { home, skillSourceDir: oldSource });
    const target = path.join(home, '.claude', 'skills', 'pi-research');

    fs.rmSync(path.join(globalBase, 'pi-research'), { recursive: true, force: true });
    expect(fs.existsSync(target)).toBe(false); // dangling

    const newSource = makeInstall(projectBase, '1.6.1', 'RELOCATED');
    const result = reconcileSkillInstalls({ home, skillSourceDir: newSource });

    expect(result.repointed).toEqual([target]);
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toContain('RELOCATED');
  });
});

describe('a hollow install is reported and repaired, not called healthy', () => {
  it('detectHarnesses flags an owned link whose target is gone', async () => {
    const { detectHarnesses } = await import('../../../src/skill-install/skill-installer.ts');
    const source = makeInstall(globalBase, '1.6.1', 'GLOBAL');
    installSkill(['claude'], { home, skillSourceDir: source });

    let claude = detectHarnesses({ home }).find(d => d.id === 'claude')!;
    expect(claude.installed).toBe('owned-symlink');
    expect(claude.broken).toBe(false);

    fs.rmSync(path.join(globalBase, 'pi-research'), { recursive: true, force: true });

    claude = detectHarnesses({ home }).find(d => d.id === 'claude')!;
    // Still ours, but dead. Reporting this as "installed" is what left the failure to
    // surface later as an opaque "Cannot find module …/scripts/run.mjs".
    expect(claude.installed).toBe('owned-symlink');
    expect(claude.broken).toBe(true);
  });

  it('detectHarnesses flags a target that exists but has been gutted', async () => {
    const { detectHarnesses } = await import('../../../src/skill-install/skill-installer.ts');
    const source = makeInstall(globalBase, '1.6.1', 'GLOBAL');
    installSkill(['claude'], { home, skillSourceDir: source });

    // Partial delete / interrupted install: the directory survives, the launcher does not.
    fs.rmSync(path.join(source, 'scripts', 'run.mjs'), { force: true });

    const claude = detectHarnesses({ home }).find(d => d.id === 'claude')!;
    expect(claude.broken).toBe(true);
  });

  it('reconcile repairs a gutted target instead of leaving it hollow', () => {
    const source = makeInstall(globalBase, '1.6.1', 'GLOBAL');
    installSkill(['claude'], { home, skillSourceDir: source });
    const target = path.join(home, '.claude', 'skills', 'pi-research');

    fs.rmSync(path.join(source, 'scripts', 'run.mjs'), { force: true });

    const fresh = makeInstall(projectBase, '1.6.1', 'REPAIRED');
    const result = reconcileSkillInstalls({ home, skillSourceDir: fresh });

    expect(result.repointed).toEqual([target]);
    expect(fs.existsSync(path.join(target, 'scripts', 'run.mjs'))).toBe(true);
  });
});
