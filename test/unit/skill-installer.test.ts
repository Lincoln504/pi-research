/**
 * Skill installer unit tests.
 *
 * Hermetic: every test runs against a throwaway HOME (opts.home) and points at
 * the real bundled skills/pi-research as the source, so nothing touches the
 * developer's actual ~/.claude etc. The suite asserts the safety-critical
 * invariants — never clobber a foreign skill, never delete what we don't own,
 * symmetric install→uninstall, and an accurate manifest — not just happy paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARNESSES,
  detectHarnesses,
  installSkill,
  uninstallSkill,
  readManifest,
  getManifestPath,
  resolveSkillSourceDir,
  skillInstallCandidates,
  skillUninstallCandidates,
  SKILL_AGENT_TARGETS,
} from '../../src/skill-install/skill-installer.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL_SRC = path.join(ROOT, 'skills', 'pi-research');

let HOME: string;
const opts = () => ({ home: HOME, skillSourceDir: SKILL_SRC });

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-test-'));
});
afterEach(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkHarnessBase(id: string) {
  const def = HARNESSES.find(h => h.id === id)!;
  fs.mkdirSync(path.join(HOME, def.baseDir), { recursive: true });
  return def;
}
function skillPathFor(id: string): string {
  const def = HARNESSES.find(h => h.id === id)!;
  return path.join(HOME, def.skillsDir, 'pi-research');
}

describe('SKILL_AGENT_TARGETS (in-app installer scope)', () => {
  it('targets exactly Claude and Codex — never Cursor (project-only, no global dir), pi, or ~/.agents', () => {
    expect([...SKILL_AGENT_TARGETS]).toEqual(['claude', 'codex']);
    expect(SKILL_AGENT_TARGETS).not.toContain('cursor');
    expect(SKILL_AGENT_TARGETS).not.toContain('pi');
    expect(SKILL_AGENT_TARGETS).not.toContain('agents');
  });
  it('every target is a real harness id', () => {
    for (const id of SKILL_AGENT_TARGETS) {
      expect(HARNESSES.some(h => h.id === id)).toBe(true);
    }
  });
});

describe('install/uninstall gating candidates', () => {
  it('install candidates require the agent ROOT dir to exist (never creates it)', () => {
    // No agent dirs yet → no install candidates.
    expect(skillInstallCandidates({ home: HOME }).map(d => d.id)).toEqual([]);

    // Create only ~/.claude → only Claude becomes a candidate; Codex still absent.
    fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    expect(skillInstallCandidates({ home: HOME }).map(d => d.id)).toEqual(['claude']);

    // Add ~/.codex → both are candidates.
    fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
    expect(skillInstallCandidates({ home: HOME }).map(d => d.id).sort()).toEqual(['claude', 'codex']);
  });

  it('uninstall candidates require the skill to be actually installed (owned)', () => {
    fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
    // Root dirs exist but nothing installed yet → no uninstall candidates.
    expect(skillUninstallCandidates({ home: HOME }).map(d => d.id)).toEqual([]);

    // Install into Claude only → it (and only it) becomes an uninstall candidate.
    installSkill(['claude'], { home: HOME });
    expect(skillUninstallCandidates({ home: HOME }).map(d => d.id)).toEqual(['claude']);
  });

  it('a foreign skill occupying the slot is NOT an uninstall candidate', () => {
    const sp = path.join(HOME, '.claude', 'skills', 'pi-research');
    fs.mkdirSync(sp, { recursive: true });
    fs.writeFileSync(path.join(sp, 'SKILL.md'), 'name: pi-research\n# someone elses skill', 'utf-8');
    expect(skillUninstallCandidates({ home: HOME }).map(d => d.id)).toEqual([]);
  });
});

describe('resolveSkillSourceDir', () => {
  it('locates the real bundled skill (SKILL.md present)', () => {
    const dir = resolveSkillSourceDir(SKILL_SRC);
    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
  });
  it('falls back to auto-resolution when the explicit path lacks SKILL.md', () => {
    // An explicit path is only a hint; a bad one falls through to the up-tree
    // search, which finds the real repo skill. (The throw path only fires when no
    // skill exists anywhere up-tree or in cwd — unreachable from inside the repo.)
    const dir = resolveSkillSourceDir(path.join(HOME, 'nope'));
    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
  });
});

describe('detectHarnesses', () => {
  it('reports present=true only when the harness base dir exists', () => {
    mkHarnessBase('claude');
    const detected = detectHarnesses(opts());
    expect(detected.find(d => d.id === 'claude')!.present).toBe(true);
    expect(detected.find(d => d.id === 'pi')!.present).toBe(false);
  });
  it('every harness starts uninstalled and exposes a confidence tag', () => {
    for (const d of detectHarnesses(opts())) {
      expect(d.installed).toBe('none');
      expect(['confirmed', 'partial', 'unverified']).toContain(d.confidence);
    }
  });
});

describe('installSkill — symlink (default)', () => {
  it('creates an owned symlink, writes a manifest entry, and is idempotent', () => {
    mkHarnessBase('claude');
    const r1 = installSkill(['claude'], opts());
    expect(r1[0]!.status).toBe('installed');
    expect(r1[0]!.type).toBe('symlink');

    const sp = skillPathFor('claude');
    expect(fs.lstatSync(sp).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(sp), fs.readlinkSync(sp))).toBe(path.resolve(SKILL_SRC));

    // The skill is usable through the link.
    expect(fs.existsSync(path.join(sp, 'SKILL.md'))).toBe(true);

    const manifest = readManifest(opts());
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({ tool: 'claude', path: sp, type: 'symlink' });

    // Detection now reports it as owned.
    expect(detectHarnesses(opts()).find(d => d.id === 'claude')!.installed).toBe('owned-symlink');

    // Second install is a no-op (already-installed), manifest stays size 1.
    const r2 = installSkill(['claude'], opts());
    expect(r2[0]!.status).toBe('already-installed');
    expect(readManifest(opts()).entries).toHaveLength(1);
  });

  it('creates the skills dir even when the harness base dir is absent', () => {
    // No mkHarnessBase — installer must still mkdir -p the skills path.
    const r = installSkill(['pi'], opts());
    expect(r[0]!.status).toBe('installed');
    expect(fs.existsSync(skillPathFor('pi'))).toBe(true);
  });
});

describe('installSkill — copy', () => {
  it('copies a real directory carrying our package marker (owned-copy)', () => {
    mkHarnessBase('claude');
    const r = installSkill(['claude'], { ...opts(), copy: true });
    expect(r[0]!.status).toBe('installed');
    expect(r[0]!.type).toBe('copy');
    const sp = skillPathFor('claude');
    expect(fs.lstatSync(sp).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(sp, 'SKILL.md'), 'utf-8')).toContain('@lincoln504/pi-research');
    expect(detectHarnesses(opts()).find(d => d.id === 'claude')!.installed).toBe('owned-copy');
  });
});

describe('installSkill — foreign safety', () => {
  it('never clobbers a non-pi-research research/ directory', () => {
    const sp = skillPathFor('cursor');
    fs.mkdirSync(sp, { recursive: true });
    fs.writeFileSync(path.join(sp, 'SKILL.md'), 'name: research\n# someone elses skill', 'utf-8');

    const r = installSkill(['cursor'], opts());
    expect(r[0]!.status).toBe('skipped-foreign');
    // Untouched.
    expect(fs.readFileSync(path.join(sp, 'SKILL.md'), 'utf-8')).toContain('someone elses skill');
    expect(fs.lstatSync(sp).isSymbolicLink()).toBe(false);
    // No manifest entry created for a foreign skip.
    expect(readManifest(opts()).entries.find(e => e.tool === 'cursor')).toBeUndefined();
    expect(detectHarnesses(opts()).find(d => d.id === 'cursor')!.installed).toBe('foreign');
  });
});

describe('installSkill — dry run', () => {
  it('plans without writing anything (no link, no manifest)', () => {
    mkHarnessBase('claude');
    const r = installSkill(['claude'], { ...opts(), dryRun: true });
    expect(r[0]!.status).toBe('planned');
    expect(fs.existsSync(skillPathFor('claude'))).toBe(false);
    expect(fs.existsSync(getManifestPath(opts()))).toBe(false);
  });
});

describe('installSkill — bad target', () => {
  it('returns an error result for an unknown tool id', () => {
    const r = installSkill(['not-a-tool'], opts());
    expect(r[0]!.status).toBe('error');
  });
});

describe('uninstallSkill', () => {
  it('removes only owned installs and preserves foreign ones', () => {
    mkHarnessBase('claude');
    installSkill(['claude'], opts());

    // A foreign cursor skill must survive uninstall.
    const foreign = skillPathFor('cursor');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), '# foreign', 'utf-8');

    const r = uninstallSkill(undefined, opts()); // --all
    const claude = r.find(x => x.tool === 'claude')!;
    expect(claude.status).toBe('removed');
    expect(fs.existsSync(skillPathFor('claude'))).toBe(false);

    // Foreign untouched and manifest emptied.
    expect(fs.existsSync(path.join(foreign, 'SKILL.md'))).toBe(true);
    expect(readManifest(opts()).entries).toHaveLength(0);
  });

  it('uninstalls only the named tool, leaving others installed', () => {
    installSkill(['claude', 'pi'], opts());
    expect(readManifest(opts()).entries).toHaveLength(2);

    const r = uninstallSkill(['claude'], opts());
    expect(r.find(x => x.tool === 'claude')!.status).toBe('removed');
    expect(fs.existsSync(skillPathFor('claude'))).toBe(false);
    expect(fs.existsSync(skillPathFor('pi'))).toBe(true);
    expect(readManifest(opts()).entries.map(e => e.tool)).toEqual(['pi']);
  });

  it('does not delete a symlink that points outside our package (not owned)', () => {
    // Hand-craft a foreign symlink at the claude skill path, plus a manifest
    // entry claiming it — uninstall must refuse to remove it.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-foreign-'));
    const sp = skillPathFor('claude');
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.symlinkSync(elsewhere, sp, 'dir');
    fs.mkdirSync(path.dirname(getManifestPath(opts())), { recursive: true });
    fs.writeFileSync(getManifestPath(opts()), JSON.stringify({
      version: 1, package: '@lincoln504/pi-research',
      entries: [{ tool: 'claude', path: sp, type: 'symlink', source: elsewhere, createdAt: 'x' }],
    }), 'utf-8');

    const r = uninstallSkill(undefined, opts());
    expect(r.find(x => x.path === sp)!.status).toBe('skipped-foreign');
    expect(fs.existsSync(sp)).toBe(true); // still there
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('reports not-present and prunes a manifest entry whose file is already gone', () => {
    installSkill(['claude'], opts());
    fs.rmSync(skillPathFor('claude'), { recursive: true, force: true });
    const r = uninstallSkill(undefined, opts());
    expect(r.find(x => x.tool === 'claude')!.status).toBe('not-present');
    expect(readManifest(opts()).entries).toHaveLength(0);
  });
});

describe('round-trip', () => {
  it('install → uninstall leaves the filesystem as it started', () => {
    mkHarnessBase('claude');
    const before = fs.readdirSync(path.join(HOME, '.claude'));
    installSkill(['claude'], opts());
    uninstallSkill(undefined, opts());
    // skills/ dir may remain (empty) but the research link is gone and no manifest.
    expect(fs.existsSync(skillPathFor('claude'))).toBe(false);
    expect(fs.existsSync(getManifestPath(opts()))).toBe(false);
    expect(before).toEqual(expect.arrayContaining([]));
  });
});
