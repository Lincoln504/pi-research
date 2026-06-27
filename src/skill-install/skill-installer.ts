/**
 * Skill installer / uninstaller
 *
 * Installs the bundled `research` Agent Skill into the skills directories of the
 * coding-agent harnesses present on this machine, by symlink (default) or copy.
 * The skill is pi-research's only cross-harness surface — every supported target
 * uses the same agentskills.io SKILL.md directory model, so a single symlink per
 * harness is all it takes; harnesses that integrate differently (e.g. via MCP
 * extensions) are intentionally NOT targeted here.
 *
 * Everything created is recorded in a manifest (~/.pi/research/installed-skills.json)
 * so uninstall removes EXACTLY what install created — and only if the target on
 * disk is still ours (a dangling/owned symlink, or a copy carrying our marker).
 * A foreign `research/` directory is never clobbered or deleted.
 *
 * Target-path confidence (see HARNESSES): 'confirmed' paths are documented by the
 * harness; 'partial'/'unverified' paths come from community/spec sources and are
 * only written on explicit opt-in (callers must pass them deliberately).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type HarnessConfidence = 'confirmed' | 'partial' | 'unverified';

export interface HarnessDef {
  /** Stable id used on the CLI (e.g. "claude"). */
  id: string;
  /** Human label. */
  label: string;
  /** Base config dir under $HOME used for presence detection (e.g. ".claude"). */
  baseDir: string;
  /** Skills dir under $HOME the skill is linked into (e.g. ".claude/skills"). */
  skillsDir: string;
  /** How sure we are the skillsDir path is correct for this harness. */
  confidence: HarnessConfidence;
  /** One-line note shown for non-confirmed targets. */
  note?: string;
}

/**
 * Supported targets. ONLY the skills-directory (SKILL.md) integration model.
 * Paths are relative to the user's home directory and resolved per-call so tests
 * can override $HOME.
 */
export const HARNESSES: readonly HarnessDef[] = [
  { id: 'claude', label: 'Claude', baseDir: '.claude', skillsDir: path.join('.claude', 'skills'), confidence: 'confirmed' },
  { id: 'pi', label: 'pi', baseDir: '.pi', skillsDir: path.join('.pi', 'skills'), confidence: 'confirmed' },
  { id: 'cursor', label: 'Cursor', baseDir: '.cursor', skillsDir: path.join('.cursor', 'skills'), confidence: 'partial', note: 'Cursor project-level skills are documented; the global ~/.cursor/skills path is community-reported.' },
  { id: 'codex', label: 'OpenAI Codex CLI', baseDir: '.codex', skillsDir: path.join('.codex', 'skills'), confidence: 'unverified', note: 'Codex skills support is emerging; path not confirmed by official docs.' },
  { id: 'agents', label: 'Cross-tool (~/.agents/skills)', baseDir: '.agents', skillsDir: path.join('.agents', 'skills'), confidence: 'unverified', note: 'Proposed Universal Agents convention; not yet a ratified standard.' },
] as const;

const SKILL_NAME = 'pi-research';
const PACKAGE_NAME = '@lincoln504/pi-research';

/**
 * The coding agents the in-app installer (the /research-config TUI) targets:
 * Claude and Codex. Both load personal skills from a home-directory
 * `~/.<agent>/skills/` path, so a single global symlink works.
 *
 * Cursor is deliberately excluded: it has no personal/global skills directory —
 * Cursor only loads skills from a project-level `.cursor/skills/`, so a global
 * `~/.cursor/skills` symlink would never be read. `pi` (the host itself) and the
 * speculative `~/.agents` convention are likewise excluded from the one-click flow.
 */
export const SKILL_AGENT_TARGETS = ['claude', 'codex'] as const;

export interface ManifestEntry {
  tool: string;
  /** Absolute path of the installed skill directory (…/skills/pi-research). */
  path: string;
  type: 'symlink' | 'copy';
  /** Absolute path of the skill source this was linked/copied from. */
  source: string;
  createdAt: string;
}

interface Manifest {
  version: 1;
  package: string;
  entries: ManifestEntry[];
}

export interface InstallOptions {
  /** Override the home directory (for tests). */
  home?: string;
  /** Copy instead of symlink. */
  copy?: boolean;
  /** Plan only — do not touch the filesystem. */
  dryRun?: boolean;
  /** Explicit skill source dir (else auto-resolved). */
  skillSourceDir?: string;
}

export type InstallStatus = 'installed' | 'already-installed' | 'skipped-foreign' | 'planned' | 'error';

export interface InstallResult {
  tool: string;
  path: string;
  type: 'symlink' | 'copy';
  status: InstallStatus;
  message?: string;
}

export type UninstallStatus = 'removed' | 'not-present' | 'skipped-foreign' | 'planned' | 'error';

export interface UninstallResult {
  tool: string;
  path: string;
  status: UninstallStatus;
  message?: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function homeDir(opts?: { home?: string }): string {
  return opts?.home ?? os.homedir();
}

/**
 * Locate the bundled skill source directory (the one containing SKILL.md).
 * Robust across both the bundled CLI (dist/cli.mjs) and unbundled test runs:
 * honors PI_RESEARCH_SKILL_DIR, then walks up from this module and from cwd
 * looking for `skills/pi-research/SKILL.md`.
 */
export function resolveSkillSourceDir(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env['PI_RESEARCH_SKILL_DIR']) candidates.push(process.env['PI_RESEARCH_SKILL_DIR']!);

  const fromHere = (() => {
    try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return undefined; }
  })();

  for (const start of [fromHere, process.cwd()]) {
    if (!start) continue;
    let dir = start;
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, 'skills', SKILL_NAME));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'SKILL.md'))) return path.resolve(c);
    } catch { /* next */ }
  }
  throw new Error('Could not locate the bundled research skill (skills/pi-research/SKILL.md). Set PI_RESEARCH_SKILL_DIR to its path.');
}

export function getManifestPath(opts?: { home?: string }): string {
  return path.join(homeDir(opts), '.pi', 'research', 'installed-skills.json');
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function readManifest(opts?: { home?: string }): Manifest {
  const p = getManifestPath(opts);
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (parsed && Array.isArray(parsed.entries)) {
        return { version: 1, package: PACKAGE_NAME, entries: parsed.entries };
      }
    }
  } catch { /* corrupt manifest → treat as empty */ }
  return { version: 1, package: PACKAGE_NAME, entries: [] };
}

function writeManifest(manifest: Manifest, opts?: { home?: string }): void {
  const p = getManifestPath(opts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

function upsertEntry(manifest: Manifest, entry: ManifestEntry): void {
  const idx = manifest.entries.findIndex(e => e.path === entry.path);
  if (idx >= 0) manifest.entries[idx] = entry;
  else manifest.entries.push(entry);
}

// ---------------------------------------------------------------------------
// Ownership checks (never delete what isn't ours)
// ---------------------------------------------------------------------------

/** A symlink we own points at the skill source (our package's skills/pi-research). */
function isOwnedSymlink(targetPath: string, expectedSource?: string): boolean {
  try {
    const st = fs.lstatSync(targetPath);
    if (!st.isSymbolicLink()) return false;
    const dest = path.resolve(path.dirname(targetPath), fs.readlinkSync(targetPath));
    if (expectedSource && path.resolve(expectedSource) === dest) return true;
    // Fallback: own it only if it points at OUR package layout, i.e. the dest
    // ends in `pi-research/skills/pi-research`. Requiring `pi-research` to be the
    // immediate parent segment of `skills/pi-research` avoids the substring false
    // positive where a foreign path like `/home/pi-researcher/.../skills/pi-research`
    // (note: pi-researcher) would otherwise be misclassified as owned and deleted.
    return /[/\\]pi-research[/\\]skills[/\\]pi-research$/.test(dest);
  } catch { return false; }
}

/** A copy we own carries our package marker in its SKILL.md. */
function isOwnedCopy(targetPath: string): boolean {
  try {
    const md = fs.readFileSync(path.join(targetPath, 'SKILL.md'), 'utf-8');
    return md.includes(PACKAGE_NAME);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectedHarness extends HarnessDef {
  present: boolean;
  /** Absolute skills dir. */
  absSkillsDir: string;
  /** Absolute …/skills/pi-research path. */
  absSkillPath: string;
  /** Current install state of THIS skill at that path. */
  installed: 'none' | 'owned-symlink' | 'owned-copy' | 'foreign';
}

export function detectHarnesses(opts?: { home?: string }): DetectedHarness[] {
  const home = homeDir(opts);
  return HARNESSES.map(h => {
    const absSkillsDir = path.join(home, h.skillsDir);
    const absSkillPath = path.join(absSkillsDir, SKILL_NAME);
    let present = false;
    try { present = fs.existsSync(path.join(home, h.baseDir)); } catch { /* no */ }
    let installed: DetectedHarness['installed'] = 'none';
    try {
      if (fs.existsSync(absSkillPath) || isSymlinkPresent(absSkillPath)) {
        if (isOwnedSymlink(absSkillPath)) installed = 'owned-symlink';
        else if (isOwnedCopy(absSkillPath)) installed = 'owned-copy';
        else installed = 'foreign';
      }
    } catch { /* none */ }
    return { ...h, present, absSkillsDir, absSkillPath, installed };
  });
}

function isSymlinkPresent(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

const isTarget = (id: string): boolean =>
  (SKILL_AGENT_TARGETS as readonly string[]).includes(id);

/**
 * Install candidates: target agents (Claude, Codex) whose ROOT config folder
 * already exists. Gate for the in-app installer — we never create an agent's
 * home dir, so an agent that isn't set up is simply not offered.
 */
export function skillInstallCandidates(opts?: { home?: string }): DetectedHarness[] {
  return detectHarnesses(opts).filter(d => isTarget(d.id) && d.present);
}

/**
 * Uninstall candidates: target agents where the skill is actually installed
 * (an owned symlink/copy on disk) — a deeper-level gate than install. Foreign
 * skills and not-installed agents are excluded.
 */
export function skillUninstallCandidates(opts?: { home?: string }): DetectedHarness[] {
  return detectHarnesses(opts).filter(d =>
    isTarget(d.id) && (d.installed === 'owned-symlink' || d.installed === 'owned-copy'));
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export function installSkill(toolIds: string[], opts: InstallOptions = {}): InstallResult[] {
  const home = homeDir(opts);
  const source = resolveSkillSourceDir(opts.skillSourceDir);
  const manifest = readManifest(opts);
  const results: InstallResult[] = [];
  const now = new Date().toISOString();

  for (const id of toolIds) {
    const def = HARNESSES.find(h => h.id === id);
    if (!def) {
      results.push({ tool: id, path: '', type: 'symlink', status: 'error', message: `unknown target "${id}"` });
      continue;
    }
    const absSkillsDir = path.join(home, def.skillsDir);
    const absSkillPath = path.join(absSkillsDir, SKILL_NAME);
    const type: 'symlink' | 'copy' = opts.copy ? 'copy' : 'symlink';

    // Already there?
    if (isOwnedSymlink(absSkillPath, source) || isOwnedCopy(absSkillPath)) {
      // An owned symlink may point at a STALE source — e.g. after `pi update`
      // relocated the package to a new (version-stamped) dir, the old link now
      // dangles and the skill is silently broken. Re-point it to the current
      // source. (Copies always reflect current content, so only links need this.)
      try {
        const lst = fs.lstatSync(absSkillPath);
        if (lst.isSymbolicLink()) {
          const dest = path.resolve(path.dirname(absSkillPath), fs.readlinkSync(absSkillPath));
          if (dest !== path.resolve(source)) {
            fs.unlinkSync(absSkillPath);
            fs.symlinkSync(source, absSkillPath, process.platform === 'win32' ? 'junction' : 'dir');
            upsertEntry(manifest, { tool: id, path: absSkillPath, type: 'symlink', source, createdAt: now });
            results.push({ tool: id, path: absSkillPath, type: 'symlink', status: 'installed', message: 're-pointed stale symlink to current source' });
            continue;
          }
        }
      } catch { /* fall through to already-installed below */ }
      results.push({ tool: id, path: absSkillPath, type, status: 'already-installed' });
      upsertEntry(manifest, { tool: id, path: absSkillPath, type: isSymlinkPresent(absSkillPath) ? 'symlink' : 'copy', source, createdAt: now });
      continue;
    }
    if (fs.existsSync(absSkillPath) || isSymlinkPresent(absSkillPath)) {
      results.push({ tool: id, path: absSkillPath, type, status: 'skipped-foreign', message: 'a non-pi-research "research" skill already exists here; left untouched' });
      continue;
    }
    if (opts.dryRun) {
      results.push({ tool: id, path: absSkillPath, type, status: 'planned' });
      continue;
    }

    try {
      fs.mkdirSync(absSkillsDir, { recursive: true });
      if (type === 'symlink') {
        try {
          fs.symlinkSync(source, absSkillPath, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (err: any) {
          // Windows without privilege, or cross-device: fall back to copy.
          copyDir(source, absSkillPath);
          upsertEntry(manifest, { tool: id, path: absSkillPath, type: 'copy', source, createdAt: now });
          results.push({ tool: id, path: absSkillPath, type: 'copy', status: 'installed', message: `symlink unavailable (${err?.code ?? err?.message}); copied instead` });
          continue;
        }
      } else {
        copyDir(source, absSkillPath);
      }
      upsertEntry(manifest, { tool: id, path: absSkillPath, type, source, createdAt: now });
      results.push({ tool: id, path: absSkillPath, type, status: 'installed' });
    } catch (err: any) {
      results.push({ tool: id, path: absSkillPath, type, status: 'error', message: err?.message ?? String(err) });
    }
  }

  if (!opts.dryRun) writeManifest(manifest, opts);
  return results;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Remove the skill from the given tools (or every manifest entry when toolIds is
 * omitted). Only removes paths we still own; foreign dirs are left untouched.
 */
export function uninstallSkill(toolIds?: string[], opts: InstallOptions = {}): UninstallResult[] {
  const manifest = readManifest(opts);
  const results: UninstallResult[] = [];
  const keep: ManifestEntry[] = [];

  // Union of manifest entries and any owned installs discovered on disk, so a
  // skill installed by an older version (or hand-symlinked into our package) is
  // still cleanable.
  const targets = new Map<string, { tool: string; path: string }>();
  for (const e of manifest.entries) targets.set(e.path, { tool: e.tool, path: e.path });
  for (const d of detectHarnesses(opts)) {
    if (d.installed === 'owned-symlink' || d.installed === 'owned-copy') {
      targets.set(d.absSkillPath, { tool: d.id, path: d.absSkillPath });
    }
  }

  for (const { tool, path: skillPath } of targets.values()) {
    if (toolIds && toolIds.length && !toolIds.includes(tool)) {
      const e = manifest.entries.find(x => x.path === skillPath);
      if (e) keep.push(e);
      continue;
    }
    const owned = isOwnedSymlink(skillPath) || isOwnedCopy(skillPath);
    const present = fs.existsSync(skillPath) || isSymlinkPresent(skillPath);
    if (!present) {
      results.push({ tool, path: skillPath, status: 'not-present' });
      continue; // drop from manifest
    }
    if (!owned) {
      results.push({ tool, path: skillPath, status: 'skipped-foreign', message: 'not a pi-research skill; left untouched' });
      const e = manifest.entries.find(x => x.path === skillPath);
      if (e) keep.push(e);
      continue;
    }
    if (opts.dryRun) {
      results.push({ tool, path: skillPath, status: 'planned' });
      const e = manifest.entries.find(x => x.path === skillPath);
      if (e) keep.push(e);
      continue;
    }
    try {
      if (isSymlinkPresent(skillPath)) fs.unlinkSync(skillPath);
      else fs.rmSync(skillPath, { recursive: true, force: true });
      results.push({ tool, path: skillPath, status: 'removed' });
    } catch (err: any) {
      results.push({ tool, path: skillPath, status: 'error', message: err?.message ?? String(err) });
      const e = manifest.entries.find(x => x.path === skillPath);
      if (e) keep.push(e);
    }
  }

  if (!opts.dryRun) {
    if (keep.length > 0) {
      writeManifest({ version: 1, package: PACKAGE_NAME, entries: keep }, opts);
    } else {
      // Nothing left to track — remove the manifest entirely (matches cleanup.cjs).
      try { fs.rmSync(getManifestPath(opts)); } catch { /* already gone */ }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}
