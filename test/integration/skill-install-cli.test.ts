/**
 * Skill installer — end-to-end integration via the BUILT CLI binary and the real
 * preuninstall script.
 *
 * Unlike the unit suite (which calls the module functions directly), this spawns
 * the actual `dist/cli.mjs` the user runs, against a throwaway HOME, and then
 * runs `scripts/cleanup.cjs` exactly as `npm uninstall` would — proving the whole
 * install → detect → uninstall → npm-uninstall chain works on disk and that
 * ownership safety holds across process boundaries.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist', 'cli.mjs');
const CLEANUP = path.join(ROOT, 'scripts', 'cleanup.cjs');

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    execSync('npm run build:cli', { cwd: ROOT, stdio: 'inherit' });
  }
}, 120_000);

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-int-')); });
afterEach(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME, USERPROFILE: HOME, PI_RESEARCH_SKILL_DIR: '' },
  });
}
function runCleanup() {
  return spawnSync(process.execPath, [CLEANUP], {
    encoding: 'utf-8',
    env: { ...process.env, HOME, USERPROFILE: HOME },
  });
}
const claudeSkill = () => path.join(HOME, '.claude', 'skills', 'research');
const manifest = () => path.join(HOME, '.pi', 'research', 'installed-skills.json');

describe('CLI: skills (detection)', () => {
  it('lists harnesses as JSON with confidence tags', () => {
    const r = cli('skills', '--json');
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout);
    expect(Array.isArray(arr)).toBe(true);
    const ids = arr.map((d: any) => d.id);
    expect(ids).toContain('claude-code');
    const cc = arr.find((d: any) => d.id === 'claude-code');
    expect(cc.confidence).toBe('confirmed');
    expect(cc.installed).toBe('none');
  });
});

describe('CLI: install-skill', () => {
  it('installs into a present confirmed target and creates a working symlink', () => {
    fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    const r = cli('install-skill', 'claude-code');
    expect(r.status).toBe(0);
    expect(fs.lstatSync(claudeSkill()).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(claudeSkill(), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(manifest())).toBe(true);

    // Detection via the CLI now reports it installed.
    const det = JSON.parse(cli('skills', '--json').stdout);
    expect(det.find((d: any) => d.id === 'claude-code').installed).toBe('owned-symlink');
  });

  it('--all with no present confirmed harness exits CONFIG (78) and writes nothing', () => {
    const r = cli('install-skill', '--all'); // empty HOME → nothing present
    expect(r.status).toBe(78);
    expect(fs.existsSync(claudeSkill())).toBe(false);
  });

  it('no target and no --all is a usage error (64)', () => {
    const r = cli('install-skill');
    expect(r.status).toBe(64);
  });

  it('refuses to clobber a foreign research skill', () => {
    const sp = claudeSkill();
    fs.mkdirSync(sp, { recursive: true });
    fs.writeFileSync(path.join(sp, 'SKILL.md'), '# foreign', 'utf-8');
    const r = cli('install-skill', 'claude-code');
    expect(r.stdout).toMatch(/foreign/i);
    expect(fs.readFileSync(path.join(sp, 'SKILL.md'), 'utf-8')).toContain('foreign');
  });
});

describe('CLI: uninstall-skill', () => {
  it('install then uninstall --all removes the symlink and clears the manifest', () => {
    fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    expect(cli('install-skill', 'claude-code').status).toBe(0);
    const r = cli('uninstall-skill', '--all');
    expect(r.status).toBe(0);
    expect(fs.existsSync(claudeSkill())).toBe(false);
    expect(fs.existsSync(manifest())).toBe(false);
  });
});

describe('preuninstall (scripts/cleanup.cjs) parity with npm uninstall', () => {
  it('removes owned skill installs and preserves foreign ones', () => {
    fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    cli('install-skill', 'claude-code');

    // A foreign skill in a different harness dir must survive.
    const foreign = path.join(HOME, '.cursor', 'skills', 'research');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), '# foreign', 'utf-8');

    const r = runCleanup();
    expect(r.status).toBe(0);
    expect(fs.existsSync(claudeSkill())).toBe(false);          // owned → removed
    expect(fs.existsSync(path.join(foreign, 'SKILL.md'))).toBe(true); // foreign → kept
    expect(fs.existsSync(manifest())).toBe(false);             // emptied
  });

  it('is a no-op when nothing was installed', () => {
    const r = runCleanup();
    expect(r.status).toBe(0);
  });
});
