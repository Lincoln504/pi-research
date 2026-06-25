/**
 * Skill cleanup — end-to-end integration of the real npm `preuninstall` script.
 *
 * Install/uninstall is now driven from the /research-config TUI (which calls the
 * skill-installer module directly — covered by test/unit/skill-installer.test.ts).
 * This suite proves the remaining out-of-process surface: `scripts/cleanup.cjs`,
 * which npm runs on `npm uninstall`, removes the installs we own and leaves
 * foreign skills untouched — across a real process boundary, against a throwaway
 * HOME. State is set up via the module (the same call the TUI makes), not a CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkill } from '../../src/skill-install/skill-installer.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLEANUP = path.join(ROOT, 'scripts', 'cleanup.cjs');

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-int-')); });
afterEach(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

function runCleanup() {
  return spawnSync(process.execPath, [CLEANUP], {
    encoding: 'utf-8',
    env: { ...process.env, HOME, USERPROFILE: HOME },
  });
}
const claudeSkill = () => path.join(HOME, '.claude', 'skills', 'pi-research');
const manifest = () => path.join(HOME, '.pi', 'research', 'installed-skills.json');

describe('preuninstall (scripts/cleanup.cjs) parity with npm uninstall', () => {
  it('removes owned skill installs and preserves foreign ones', () => {
    // Install exactly as the TUI does (symlink + manifest), into a throwaway HOME.
    fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    const r0 = installSkill(['claude-code'], { home: HOME });
    expect(r0[0]!.status).toBe('installed');
    expect(fs.lstatSync(claudeSkill()).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(manifest())).toBe(true);

    // A foreign skill in a different harness dir must survive.
    const foreign = path.join(HOME, '.cursor', 'skills', 'pi-research');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), '# foreign', 'utf-8');

    const r = runCleanup();
    expect(r.status).toBe(0);
    expect(fs.existsSync(claudeSkill())).toBe(false);                 // owned → removed
    expect(fs.existsSync(path.join(foreign, 'SKILL.md'))).toBe(true); // foreign → kept
    expect(fs.existsSync(manifest())).toBe(false);                    // emptied
  });

  it('is a no-op when nothing was installed', () => {
    const r = runCleanup();
    expect(r.status).toBe(0);
  });
});
