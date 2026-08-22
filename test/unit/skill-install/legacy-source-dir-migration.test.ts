/**
 * Migration pin: links created before the shipped skill moved from `skills/` to
 * `agent-skill/` must keep working.
 *
 * The skill source directory was renamed because `pi` convention-scans a
 * package-root `skills/` directory and loaded our SKILL.md as a pi agent skill.
 * Every install created before that rename points at `<pkg>/skills/pi-research`,
 * which no longer exists after an upgrade — so the symlink dangles.
 *
 * `reconcileSkillInstalls` runs on every CLI invocation and every extension
 * activation and is what repairs this: it re-points a stale/dangling owned link
 * at the current source. But ownership is decided by `isOwnedSymlink`, and three
 * of its four call sites pass no expected source, falling back to matching the
 * destination's SHAPE (`…/pi-research/<source-dir>/pi-research`). That regex must
 * therefore accept BOTH directory names:
 *
 *   - drop the LEGACY name and pre-rename links read as foreign — reconcile
 *     refuses to re-point them, uninstall refuses to remove them, and status
 *     reports someone else's skill in the slot;
 *   - drop the CURRENT name and the link we just re-pointed becomes unmanageable
 *     on the very next pass, so a later relocation can never be repaired.
 *
 * The second case is the subtle one: the migration appears to succeed, and only a
 * subsequent upgrade reveals the link was orphaned. Both directions are pinned.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  installSkill,
  reconcileSkillInstalls,
  uninstallSkill,
  detectHarnesses,
} from '../../../src/skill-install/skill-installer.ts';

let root: string;
let home: string;

/** A package tree whose skill sits in `dirName` (…/pi-research/<dirName>/pi-research). */
function makePackageSource(dirName: string, version: string, label = dirName): string {
  const src = path.join(root, `pkg-${label}`, 'pi-research', dirName, 'pi-research');
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(src, 'SKILL.md'),
    `---\nname: pi-research\nmetadata: { "version": "${version}", "package": "@lincoln504/pi-research" }\n---\n`,
  );
  fs.writeFileSync(path.join(src, 'scripts', 'run.mjs'), '// launcher\n');
  return src;
}

const claudeLink = (): string => path.join(home, '.claude', 'skills', 'pi-research');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-migration-'));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('shipped skill dir rename — legacy install migration', () => {
  it('re-points a dangling pre-rename link at the new source, and keeps managing it afterwards', () => {
    const legacy = makePackageSource('skills', '1.5.2');
    const installed = installSkill(['claude'], { home, skillSourceDir: legacy });
    expect(installed[0]!.status).toBe('installed');
    expect(fs.readlinkSync(claudeLink())).toBe(legacy);

    // Upgrade: the package now ships the skill under agent-skill/, so the old
    // path is gone and the existing link dangles.
    fs.rmSync(path.join(root, 'pkg-skills'), { recursive: true, force: true });
    const current = makePackageSource('agent-skill', '1.5.3');
    expect(fs.existsSync(claudeLink())).toBe(false); // dangling

    const first = reconcileSkillInstalls({ home, skillSourceDir: current });
    expect(first.repointed).toEqual([claudeLink()]);
    expect(fs.readlinkSync(claudeLink())).toBe(current);
    expect(fs.existsSync(claudeLink())).toBe(true); // resolves again

    // The repointed link must still be recognised as OURS. If the ownership
    // regex only knew the legacy name, this would report 'foreign' (or, because
    // isOwnedCopy reads SKILL.md through the link and finds our package marker,
    // the misleading 'owned-copy') and nothing would manage the link again.
    const claude = detectHarnesses({ home }).find(d => d.id === 'claude');
    expect(claude!.installed).toBe('owned-symlink');

    // Proof that management continues: relocate again and reconcile must repair it.
    fs.rmSync(path.join(root, 'pkg-agent-skill'), { recursive: true, force: true });
    const relocated = makePackageSource('agent-skill', '1.5.4', 'agent-skill-v2');
    const second = reconcileSkillInstalls({ home, skillSourceDir: relocated });
    expect(second.repointed).toEqual([claudeLink()]);
    expect(fs.readlinkSync(claudeLink())).toBe(relocated);
  });

  it('is idempotent — a reconcile with nothing stale changes nothing', () => {
    const current = makePackageSource('agent-skill', '1.5.3');
    installSkill(['claude'], { home, skillSourceDir: current });

    const r = reconcileSkillInstalls({ home, skillSourceDir: current });
    expect(r).toEqual({ pruned: [], repointed: [], refreshed: [] });
    expect(fs.readlinkSync(claudeLink())).toBe(current);
  });

  it('still uninstalls a pre-rename link that was never reconciled', () => {
    // A user who uninstalls without ever running a reconcile first: the link
    // still points at the legacy layout and must be recognised and removed.
    const legacy = makePackageSource('skills', '1.5.2');
    installSkill(['claude'], { home, skillSourceDir: legacy });

    const results = uninstallSkill(['claude'], { home, skillSourceDir: legacy });
    expect(results[0]!.status).toBe('removed');
    expect(fs.existsSync(claudeLink())).toBe(false);
  });

  it('never claims a foreign link whose path merely resembles ours', () => {
    // The `pi-researcher` case the ownership guard was written for: a similarly
    // named directory belonging to someone else must stay untouched.
    const foreign = path.join(root, 'pi-researcher', 'agent-skill', 'pi-research');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), '# someone elses skill\n');
    fs.symlinkSync(foreign, claudeLink(), 'dir');

    const claude = detectHarnesses({ home }).find(d => d.id === 'claude');
    expect(claude!.installed).toBe('foreign');

    const current = makePackageSource('agent-skill', '1.5.3');
    reconcileSkillInstalls({ home, skillSourceDir: current });
    expect(fs.readlinkSync(claudeLink())).toBe(foreign); // untouched
  });
});
