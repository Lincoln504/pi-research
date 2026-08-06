/**
 * scripts/cleanup.cjs — state-dir containment.
 *
 * Regression under test: the state sweep rm'd the PI_RESEARCH_STATE_DIR override
 * ITSELF, with no ownership check — the cache sweep is namespaced
 * (join(cacheHome, 'pi-research')) but a user pointing the state override at a
 * shared directory lost EVERYTHING in it. The fix removes only the entries the
 * runtime actually creates there when the override path is not itself
 * pi-research-namespaced, and keeps wholesale removal for namespaced paths and
 * the default location.
 *
 * Every spawn uses a FULLY pinned env (never the inherited one): cleanup.cjs
 * resolves the trees it deletes from HOME / XDG_CACHE_HOME / PI_RESEARCH_STATE_DIR
 * / PI_RESEARCH_CONFIG_DIR_NAME, and any inherited value would aim the rm at real
 * user state (mirrors test/integration/skill-preuninstall.test.ts's pinning).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLEANUP = path.join(ROOT, 'scripts', 'cleanup.cjs');

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pir-cleanup-unit-')); });
afterEach(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

function runCleanup(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    // Built from scratch — NOT ...process.env — so no real path can leak in.
    PATH: process.env['PATH'] ?? '',
    HOME,
    USERPROFILE: HOME,
    XDG_CACHE_HOME: path.join(HOME, '.cache'),
    ...extra,
  };
  return spawnSync(process.execPath, [CLEANUP], { encoding: 'utf-8', env, cwd: HOME, timeout: 30_000 });
}

/** Populate `dir` with exactly the entries the runtime creates in a state dir. */
function plantStateEntries(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'research-state.json'), '{}', 'utf-8');
  fs.writeFileSync(path.join(dir, 'research-state-deadbeef.tmp'), '', 'utf-8');
  fs.mkdirSync(path.join(dir, '.locks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.locks', 'research-state.lock'), '', 'utf-8');
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', 'research-state.json.bak'), '{}', 'utf-8');
  fs.writeFileSync(path.join(dir, 'project-settings.json'), '{}', 'utf-8');
  fs.writeFileSync(path.join(dir, 'project-settings.json.lock'), '', 'utf-8');
  fs.writeFileSync(path.join(dir, 'research-run-slot-0.lock'), '', 'utf-8');
}

describe('cleanup.cjs — PI_RESEARCH_STATE_DIR containment', () => {
  it('a shared (non-namespaced) override loses ONLY the pi-research-owned entries, never the directory', () => {
    const shared = path.join(HOME, 'shared-data');
    plantStateEntries(shared);
    // The user's own content sharing that directory.
    fs.writeFileSync(path.join(shared, 'keep.txt'), 'user data', 'utf-8');
    fs.mkdirSync(path.join(shared, 'user-project'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'user-project', 'notes.md'), '# mine', 'utf-8');

    const r = runCleanup({ PI_RESEARCH_STATE_DIR: shared });
    expect(r.status).toBe(0);

    // The directory and the user's content survive…
    expect(fs.existsSync(shared)).toBe(true);
    expect(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf-8')).toBe('user data');
    expect(fs.existsSync(path.join(shared, 'user-project', 'notes.md'))).toBe(true);
    // …while every pi-research-owned entry is gone.
    for (const name of [
      'research-state.json',
      'research-state-deadbeef.tmp',
      '.locks',
      'backups',
      'project-settings.json',
      'project-settings.json.lock',
      'research-run-slot-0.lock',
    ]) {
      expect(fs.existsSync(path.join(shared, name)), name).toBe(false);
    }
  });

  it('an override that merely has a "pi-research"-named segment is NOT treated as proof of exclusive ownership', () => {
    // Regression: isPiResearchNamespaced() used to treat ANY path segment
    // literally equal to "pi-research" as sufficient proof the whole directory
    // was exclusively ours, and wholesale-rm'd it. But naming a directory after
    // the tool you point it at is a completely natural thing for a user to do —
    // e.g. organizing several tools' state side by side under
    // ~/agents-state/<tool-name>/ — and nothing stops them from also keeping
    // unrelated content in that same folder. A bare name match can't tell the
    // two cases apart, so it must never authorize wholesale deletion; only the
    // exact default `<dirName>/research` layout (something WE constructed) can.
    const namespaced = path.join(HOME, 'agents-state', 'pi-research');
    plantStateEntries(namespaced);
    fs.writeFileSync(path.join(namespaced, 'keep.txt'), 'user data', 'utf-8');

    const r = runCleanup({ PI_RESEARCH_STATE_DIR: namespaced });
    expect(r.status).toBe(0);

    // The directory and the user's foreign content survive…
    expect(fs.existsSync(namespaced)).toBe(true);
    expect(fs.readFileSync(path.join(namespaced, 'keep.txt'), 'utf-8')).toBe('user data');
    // …while every pi-research-owned entry is still gone.
    for (const name of [
      'research-state.json',
      'research-state-deadbeef.tmp',
      '.locks',
      'backups',
      'project-settings.json',
      'project-settings.json.lock',
      'research-run-slot-0.lock',
    ]) {
      expect(fs.existsSync(path.join(namespaced, name)), name).toBe(false);
    }
  });

  it('an override matching the exact default <dirName>/research layout is still removed wholesale', () => {
    // Provably ours: this is the same layout the runtime would construct with
    // no override at all, just rooted under a different HOME-equivalent.
    const namespaced = path.join(HOME, 'opt', '.pi', 'research');
    plantStateEntries(namespaced);
    const r = runCleanup({ PI_RESEARCH_STATE_DIR: namespaced });
    expect(r.status).toBe(0);
    expect(fs.existsSync(namespaced)).toBe(false);
  });

  it('the default ~/.pi/research/state tree is still removed wholesale', () => {
    const def = path.join(HOME, '.pi', 'research', 'state');
    plantStateEntries(def);
    const r = runCleanup();
    expect(r.status).toBe(0);
    expect(fs.existsSync(def)).toBe(false);
    // The surrounding config dir (config.env home) is preserved as before.
    expect(fs.existsSync(path.join(HOME, '.pi', 'research'))).toBe(true);
  });
});
