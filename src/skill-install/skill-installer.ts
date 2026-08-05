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

import * as crypto from 'node:crypto';
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
  { id: 'openclaw', label: 'OpenClaw', baseDir: '.openclaw', skillsDir: path.join('.openclaw', 'skills'), confidence: 'confirmed', note: 'OpenClaw reads ~/.openclaw/skills as a managed skill root and accepts symlinked skill folders (docs.openclaw.ai/tools/skills).' },
  { id: 'pi', label: 'pi', baseDir: '.pi', skillsDir: path.join('.pi', 'skills'), confidence: 'confirmed' },
  { id: 'cursor', label: 'Cursor', baseDir: '.cursor', skillsDir: path.join('.cursor', 'skills'), confidence: 'partial', note: 'Cursor project-level skills are documented; the global ~/.cursor/skills path is community-reported.' },
  { id: 'codex', label: 'OpenAI Codex CLI', baseDir: '.codex', skillsDir: path.join('.codex', 'skills'), confidence: 'unverified', note: 'Codex skills support is emerging; path not confirmed by official docs.' },
  { id: 'agents', label: 'Cross-tool (~/.agents/skills)', baseDir: '.agents', skillsDir: path.join('.agents', 'skills'), confidence: 'unverified', note: 'Proposed Universal Agents convention; not yet a ratified standard.' },
] as const;

const SKILL_NAME = 'pi-research';
const PACKAGE_NAME = '@lincoln504/pi-research';

/**
 * This package's version, used to stamp manifest entries so a stale COPY can be
 * detected and refreshed. Read from the SKILL.md we are about to install rather
 * than from package.json: that file is the copied artifact, its metadata line is
 * kept in sync by the `version` npm script, and it is present in every layout
 * (repo, published tarball, installed copy). Returns null if unreadable, which
 * simply means "cannot tell" — the entry is then always treated as stale, which
 * refreshes rather than skips.
 */
function readSkillVersion(sourceDir: string): string | null {
  try {
    const md = fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf-8');
    return /"version"\s*:\s*"([^"]+)"/.exec(md)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The coding agents the in-app installer (the /research-config TUI) targets:
 * Claude, Codex, and OpenClaw. Each loads skills from a home-directory
 * `~/.<agent>/skills/` path — OpenClaw reads `~/.openclaw/skills` as a managed
 * skill root that accepts symlinked skill folders — so a single global symlink
 * works. Every target is gated on the agent's config dir already existing (see
 * skillInstallCandidates), so a tool that isn't set up is never offered and we
 * never create its home dir.
 *
 * Cursor is deliberately excluded: it has no personal/global skills directory —
 * Cursor only loads skills from a project-level `.cursor/skills/`, so a global
 * `~/.cursor/skills` symlink would never be read. `pi` (the host itself) and the
 * speculative `~/.agents` convention are likewise excluded from the one-click flow.
 */
export const SKILL_AGENT_TARGETS = ['claude', 'codex', 'openclaw'] as const;

export interface ManifestEntry {
  tool: string;
  /** Absolute path of the installed skill directory (…/skills/pi-research). */
  path: string;
  type: 'symlink' | 'copy';
  /** Absolute path of the skill source this was linked/copied from. */
  source: string;
  createdAt: string;
  /**
   * Package version that produced this entry.
   *
   * Only load-bearing for `copy` entries: a symlink re-reads the package on every
   * use and so is always current, but a COPY is a point-in-time snapshot that
   * nothing ever refreshed — reconcile skipped non-symlinks entirely, and the
   * entry recorded no version, so drift was undetectable by construction. Copies
   * are not rare: they happen on Windows without symlink privilege, cross-device,
   * with `--copy`, and via the documented OpenClaw install route. Those users kept
   * the SKILL.md their engine shipped with *forever* — including its exit-code
   * contract — while the engine underneath them changed.
   *
   * Optional so manifests written before this field are still valid; an entry with
   * no version simply reads as "not current" and is refreshed once.
   */
  version?: string;
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
  const skillVersion = readSkillVersion(source);

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
            // dryRun means "plan only, touch nothing" — the re-point is a real
            // unlink+symlink and must honour it like the fresh-install path does.
            if (opts.dryRun) {
              results.push({ tool: id, path: absSkillPath, type: 'symlink', status: 'planned', message: 'would re-point stale symlink to current source' });
              continue;
            }
            fs.unlinkSync(absSkillPath);
            fs.symlinkSync(source, absSkillPath, process.platform === 'win32' ? 'junction' : 'dir');
            upsertEntry(manifest, { tool: id, path: absSkillPath, type: 'symlink', source, createdAt: now, ...(skillVersion ? { version: skillVersion } : {}) });
            results.push({ tool: id, path: absSkillPath, type: 'symlink', status: 'installed', message: 're-pointed stale symlink to current source' });
            continue;
          }
        }
      } catch { /* fall through to already-installed below */ }
      results.push({ tool: id, path: absSkillPath, type, status: 'already-installed' });
      upsertEntry(manifest, { tool: id, path: absSkillPath, type: isSymlinkPresent(absSkillPath) ? 'symlink' : 'copy', source, createdAt: now, ...(skillVersion ? { version: skillVersion } : {}) });
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
          upsertEntry(manifest, { tool: id, path: absSkillPath, type: 'copy', source, createdAt: now, ...(skillVersion ? { version: skillVersion } : {}) });
          results.push({ tool: id, path: absSkillPath, type: 'copy', status: 'installed', message: `symlink unavailable (${err?.code ?? err?.message}); copied instead` });
          continue;
        }
      } else {
        copyDir(source, absSkillPath);
      }
      upsertEntry(manifest, { tool: id, path: absSkillPath, type, source, createdAt: now, ...(skillVersion ? { version: skillVersion } : {}) });
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
      else fs.rmSync(skillPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
// Reconcile (self-heal on startup)
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /** Dead owned symlinks removed (target package gone, no current source). */
  pruned: string[];
  /** Stale/dangling owned symlinks re-pointed to the current package source. */
  repointed: string[];
  /**
   * Owned COPIES refreshed because the package version moved on. A symlink tracks
   * the package automatically; a copy does not, so without this an upgrade left
   * copy-installed users on the previous SKILL.md indefinitely.
   */
  refreshed: string[];
}

/**
 * Self-heal the cross-harness skill installs. Cheap, best-effort, idempotent —
 * meant to run once on extension/CLI startup.
 *
 * Why this exists: the host removes a pi-research install by deleting its
 * directory (git path) or via `npm uninstall` — and modern npm does NOT run the
 * `preuninstall` lifecycle for a removed dependency, so `cleanup.cjs` never
 * fires on uninstall. A skill symlink the user installed into another agent
 * (~/.claude/skills, ~/.codex/skills) therefore dangles after the package is
 * removed or relocated by an update. The next time ANY pi-research runs, this:
 *   - re-points an owned symlink whose target moved (update/reinstall) to the
 *     current source, so the skill keeps working without a manual re-install;
 *   - removes an owned symlink that now dangles with no resolvable source, and
 *     drops manifest entries whose link the user deleted by hand.
 * Foreign (non-owned) paths and self-contained copies are never touched.
 */
export function reconcileSkillInstalls(opts: InstallOptions = {}): ReconcileResult {
  const result: ReconcileResult = { pruned: [], repointed: [], refreshed: [] };
  const manifest = readManifest(opts);
  if (manifest.entries.length === 0) return result;

  let source: string | null;
  try { source = resolveSkillSourceDir(opts.skillSourceDir); } catch { source = null; }

  const currentVersion = source !== null ? readSkillVersion(source) : null;

  const keep: ManifestEntry[] = [];
  for (const e of manifest.entries) {
    // A COPY has no target to dangle, but it is a point-in-time snapshot: unlike a
    // symlink it does not track the package, so an engine upgrade leaves it serving
    // the OLD SKILL.md — including its exit-code contract — indefinitely. Refresh it
    // when the stamped version differs from what we now ship. An entry written
    // before versions were stamped has none, so it reads as stale and is refreshed
    // once. Ownership is re-checked first: a foreign directory at this path is
    // never overwritten.
    if (e.type !== 'symlink') {
      const stale = currentVersion !== null && e.version !== currentVersion;
      if (stale && source !== null && fs.existsSync(e.path) && isOwnedCopy(e.path)) {
        // Build-then-swap, never rm-then-copy. The old shape (rmSync, then
        // copyDir) destroyed the install permanently when the copy failed
        // (ENOSPC, a locked file): the retry guard requires the path to exist,
        // so a vanished install was never retried either. The staging names are
        // dot-prefixed so a crash mid-swap cannot leave a directory a skill
        // scanner would pick up as a duplicate skill.
        const dir = path.dirname(e.path);
        const base = path.basename(e.path);
        // Sweep leftovers from a previous crashed swap before starting a new one.
        try {
          for (const name of fs.readdirSync(dir)) {
            if (name.startsWith(`.${base}.new-`) || name.startsWith(`.${base}.old-`)) {
              fs.rmSync(path.join(dir, name), { recursive: true, force: true });
            }
          }
        } catch { /* hygiene only */ }
        const suffix = crypto.randomBytes(4).toString('hex');
        const fresh = path.join(dir, `.${base}.new-${suffix}`);
        const retired = path.join(dir, `.${base}.old-${suffix}`);
        try {
          copyDir(source, fresh);
        } catch {
          try { fs.rmSync(fresh, { recursive: true, force: true }); } catch { /* best effort */ }
          keep.push(e); // source unreadable / disk full — install intact, retry next startup
          continue;
        }
        try {
          fs.renameSync(e.path, retired);
        } catch {
          try { fs.rmSync(fresh, { recursive: true, force: true }); } catch { /* best effort */ }
          keep.push(e); // could not move the old copy aside (locked on Windows) — intact
          continue;
        }
        try {
          fs.renameSync(fresh, e.path);
        } catch {
          // Put the old copy back — an old skill is strictly better than none.
          try { fs.renameSync(retired, e.path); } catch { /* skills dir itself broken */ }
          try { fs.rmSync(fresh, { recursive: true, force: true }); } catch { /* best effort */ }
          keep.push(e);
          continue;
        }
        try { fs.rmSync(retired, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* leaked dot-dir; swept next reconcile */ }
        keep.push({ ...e, source, version: currentVersion });
        result.refreshed.push(e.path);
      } else {
        keep.push(e);
      }
      continue;
    }

    // Link the user deleted by hand — nothing on disk; drop the stale entry.
    if (!isSymlinkPresent(e.path)) { result.pruned.push(e.path); continue; }

    // Only ever touch links we own; a foreign link at this path stays + tracked.
    if (!isOwnedSymlink(e.path)) { keep.push(e); continue; }

    const targetLive = fs.existsSync(e.path); // existsSync follows the link
    let dest: string | null = null;
    try { dest = path.resolve(path.dirname(e.path), fs.readlinkSync(e.path)); } catch { /* unreadable */ }

    const stale = source !== null && dest !== null && dest !== path.resolve(source);
    if (!targetLive || stale) {
      if (source !== null) {
        // Re-point to the current package source (handles update/reinstall).
        try {
          fs.unlinkSync(e.path);
          fs.symlinkSync(source, e.path, process.platform === 'win32' ? 'junction' : 'dir');
          keep.push({ ...e, type: 'symlink', source });
          result.repointed.push(e.path);
        } catch { keep.push(e); /* leave entry; retry next startup */ }
      } else if (!targetLive) {
        // Dangling with no resolvable source (package fully removed): remove the
        // dead link and drop the entry so the agent's skills dir stays clean.
        try { fs.unlinkSync(e.path); result.pruned.push(e.path); }
        catch { keep.push(e); }
      } else {
        keep.push(e);
      }
      continue;
    }
    keep.push(e);
  }

  if (keep.length > 0) writeManifest({ version: 1, package: PACKAGE_NAME, entries: keep }, opts);
  else { try { fs.rmSync(getManifestPath(opts)); } catch { /* already gone */ } }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursive copy at the JS level — deliberately NOT fs.cpSync. cpSync's native
 * implementation (std::filesystem) ABORTS the whole process on an unreadable
 * directory instead of throwing a catchable error (observed on Node 25:
 * "terminate called after throwing an instance of
 * 'std::filesystem::__cxx11::filesystem_error'"). This runs inside
 * reconcileSkillInstalls at every startup, where a copy failure must be caught
 * and rolled back — never take the host down. statSync/copyFileSync follow
 * symlinks, matching the dereference behaviour cpSync was given.
 */
function copyDir(src: string, dest: string): void {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyDir(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}
