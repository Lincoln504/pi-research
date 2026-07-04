/**
 * CLI unit tests — parseArgs + subprocess integration.
 *
 * parseArgs tests exercise the argument-parsing logic directly (pure function,
 * no I/O). Subprocess tests verify the CLI binary's end-to-end behaviour for
 * paths that can run without a live model (help, version, bad args).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// parseArgs (unit)
// ---------------------------------------------------------------------------

// Guard: skip mocked-module bleed from other test files by importing after
// all vi.mock() calls.  parseArgs and UsageError are pure — no side effects
// on import because the _isMain guard prevents top-level execution.
import { parseArgs, UsageError, EXIT } from '../../src/cli.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist', 'cli.mjs');
const SKILL_LAUNCHER = path.join(ROOT, 'skills', 'pi-research', 'scripts', 'run.mjs');

// The subprocess suites below spawn the BUILT artifacts (dist/cli.mjs and the
// skill launcher run.mjs). These are produced by `npm run prepare` on install,
// but a CI job that restores a node_modules cache HIT skips `npm ci` (and thus
// `prepare`), leaving dist/ absent. Build on demand if missing so the suite is
// self-sufficient regardless of cache state — locally and in CI — instead of
// failing with an opaque "module not found" from the spawned node process.
beforeAll(() => {
  if (!existsSync(CLI) || !existsSync(SKILL_LAUNCHER)) {
    execSync('npm run build:cli && npm run build:skill', { cwd: ROOT, stdio: 'inherit' });
  }
}, 120_000);

// ---------------------------------------------------------------------------
// parseArgs — no-arg / help variants
// ---------------------------------------------------------------------------

describe('parseArgs — help / version', () => {
  it('no args → help', () => {
    expect(parseArgs(['node', 'cli.mjs'])).toMatchObject({ command: 'help' });
  });

  it('-h → help', () => {
    expect(parseArgs(['node', 'cli.mjs', '-h'])).toMatchObject({ command: 'help' });
  });

  it('--help → help', () => {
    expect(parseArgs(['node', 'cli.mjs', '--help'])).toMatchObject({ command: 'help' });
  });

  it('help → help', () => {
    expect(parseArgs(['node', 'cli.mjs', 'help'])).toMatchObject({ command: 'help' });
  });

  it('-v → version', () => {
    expect(parseArgs(['node', 'cli.mjs', '-v'])).toMatchObject({ command: 'version' });
  });

  it('--version → version', () => {
    expect(parseArgs(['node', 'cli.mjs', '--version'])).toMatchObject({ command: 'version' });
  });
});

// ---------------------------------------------------------------------------
// parseArgs — status
// ---------------------------------------------------------------------------

describe('parseArgs — status', () => {
  it('status bare', () => {
    const r = parseArgs(['node', 'cli.mjs', 'status']);
    expect(r.command).toBe('status');
    expect(r.status?.json).toBe(false);
    expect(r.configPath).toBeUndefined();
  });

  it('status --json', () => {
    const r = parseArgs(['node', 'cli.mjs', 'status', '--json']);
    expect(r.command).toBe('status');
    expect(r.status?.json).toBe(true);
  });

  it('status --config /tmp/x.env', () => {
    const r = parseArgs(['node', 'cli.mjs', 'status', '--config', '/tmp/x.env']);
    expect(r.command).toBe('status');
    expect(r.configPath).toBe('/tmp/x.env');
  });
});

// ---------------------------------------------------------------------------
// parseArgs — knowledge
// ---------------------------------------------------------------------------

describe('parseArgs — knowledge', () => {
  it('single query', () => {
    const r = parseArgs(['node', 'cli.mjs', 'knowledge', 'what is rust']);
    expect(r.command).toBe('knowledge');
    expect(r.knowledge?.queries).toEqual(['what is rust']);
    expect(r.knowledge?.json).toBe(false);
  });

  it('multiple queries (up to 5)', () => {
    const r = parseArgs(['node', 'cli.mjs', 'knowledge', 'a', 'b', 'c', 'd', 'e']);
    expect(r.knowledge?.queries).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('knowledge --json', () => {
    const r = parseArgs(['node', 'cli.mjs', 'knowledge', 'topic', '--json']);
    expect(r.knowledge?.json).toBe(true);
    expect(r.knowledge?.queries).toEqual(['topic']);
  });

  it('knowledge no query → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'knowledge'])).toThrow(UsageError);
  });

  it('knowledge 6 queries → UsageError (max 5)', () => {
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'knowledge', 'a', 'b', 'c', 'd', 'e', 'f']),
    ).toThrow(UsageError);
  });

  it('knowledge unknown flag → UsageError', () => {
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'knowledge', '--bogus', 'query']),
    ).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — knowledge-config
// ---------------------------------------------------------------------------

describe('parseArgs — knowledge-config', () => {
  it('bare command defaults to the show action', () => {
    const r = parseArgs(['node', 'cli.mjs', 'knowledge-config']);
    expect(r.command).toBe('knowledge-config');
    expect(r.knowledgeConfig).toEqual({ action: 'show', json: false });
  });

  it('explicit show with --json', () => {
    const r = parseArgs(['node', 'cli.mjs', 'knowledge-config', 'show', '--json']);
    expect(r.knowledgeConfig).toEqual({ action: 'show', json: true });
  });

  it('set with each valid mode', () => {
    for (const mode of ['none', 'project', 'global'] as const) {
      const r = parseArgs(['node', 'cli.mjs', 'knowledge-config', 'set', mode]);
      expect(r.knowledgeConfig).toEqual({ action: 'set', mode, json: false });
    }
  });

  it('set --json is carried through', () => {
    const r = parseArgs(['node', 'cli.mjs', 'knowledge-config', 'set', 'project', '--json']);
    expect(r.knowledgeConfig).toEqual({ action: 'set', mode: 'project', json: true });
  });

  it('set with no mode → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'knowledge-config', 'set'])).toThrow(UsageError);
  });

  it('set with an invalid mode → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'knowledge-config', 'set', 'sometimes'])).toThrow(UsageError);
  });

  it('set with an extra positional arg → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'knowledge-config', 'set', 'project', 'extra'])).toThrow(UsageError);
  });

  it('unknown action → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'knowledge-config', 'toggle'])).toThrow(UsageError);
  });

  it('unknown flag → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'knowledge-config', '--bogus'])).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — skill
// ---------------------------------------------------------------------------

describe('parseArgs — skill', () => {
  it('bare `skill` defaults to the status action', () => {
    const r = parseArgs(['node', 'cli.mjs', 'skill']);
    expect(r.command).toBe('skill');
    expect(r.skill).toEqual({ action: 'status', json: false, dryRun: false, copy: false });
  });

  it('each explicit action is parsed', () => {
    for (const action of ['status', 'install', 'uninstall'] as const) {
      const r = parseArgs(['node', 'cli.mjs', 'skill', action]);
      expect(r.skill).toEqual({ action, json: false, dryRun: false, copy: false });
    }
  });

  it('carries --json, --dry-run and --copy flags', () => {
    const r = parseArgs(['node', 'cli.mjs', 'skill', 'install', '--copy', '--dry-run', '--json']);
    expect(r.skill).toEqual({ action: 'install', json: true, dryRun: true, copy: true });
  });

  it('unknown action → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'skill', 'reinstall'])).toThrow(UsageError);
  });

  it('extra positional after the action → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'skill', 'install', 'claude'])).toThrow(UsageError);
  });

  it('unknown flag → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'skill', '--force'])).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — research
// ---------------------------------------------------------------------------

describe('parseArgs — research', () => {
  it('simple query', () => {
    const r = parseArgs(['node', 'cli.mjs', 'research', 'solid-state batteries']);
    expect(r.command).toBe('research');
    expect(r.research?.query).toBe('solid-state batteries');
    expect(r.research?.depth).toBeUndefined();
    expect(r.research?.model).toBeUndefined();
  });

  it('multi-word positional joined with space', () => {
    const r = parseArgs(['node', 'cli.mjs', 'research', 'word1', 'word2', 'word3']);
    expect(r.research?.query).toBe('word1 word2 word3');
  });

  it('--depth 2', () => {
    const r = parseArgs(['node', 'cli.mjs', 'research', 'topic', '--depth', '2']);
    expect(r.research?.depth).toBe(2);
  });

  it('--depth 0 is valid', () => {
    const r = parseArgs(['node', 'cli.mjs', 'research', 'topic', '--depth', '0']);
    expect(r.research?.depth).toBe(0);
  });

  it('--depth 4 → UsageError', () => {
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'research', 'topic', '--depth', '4']),
    ).toThrow(UsageError);
  });

  it('--depth NaN → UsageError', () => {
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'research', 'topic', '--depth', 'x']),
    ).toThrow(UsageError);
  });

  it('--model provider/id', () => {
    const r = parseArgs(['node', 'cli.mjs', 'research', 'topic', '--model', 'openai/gpt-4o']);
    expect(r.research?.model).toBe('openai/gpt-4o');
  });

  it('--model without value → UsageError', () => {
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'research', 'topic', '--model']),
    ).toThrow(UsageError);
  });

  it('--exclude-tools comma list', () => {
    const r = parseArgs([
      'node',
      'cli.mjs',
      'research',
      'topic',
      '--exclude-tools',
      'security,stackexchange',
    ]);
    expect(r.research?.excludeTools).toEqual(['security', 'stackexchange']);
  });

  it('--initial-links stops at next flag', () => {
    const r = parseArgs([
      'node',
      'cli.mjs',
      'research',
      'topic',
      '--initial-links',
      'https://a.com',
      'https://b.com',
      '--depth',
      '1',
    ]);
    expect(r.research?.initialLinks).toEqual(['https://a.com', 'https://b.com']);
    expect(r.research?.depth).toBe(1);
  });

  it('research no query and no --initial-links → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'research'])).toThrow(UsageError);
  });

  it('research --initial-links without a query → UsageError up front (links-only was a dead path: exit 64 later anyway)', () => {
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'research', '--initial-links', 'https://a.com']),
    ).toThrow(/requires a query.*--initial-links/);
  });

  it('-- terminates flags and rest becomes query', () => {
    const r = parseArgs(['node', 'cli.mjs', 'research', '--', '--looks-like-a-flag']);
    expect(r.research?.query).toBe('--looks-like-a-flag');
  });

  it('unknown flag → UsageError', () => {
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'research', 'topic', '--bogus']),
    ).toThrow(UsageError);
  });

  it('research --json sets json flag', () => {
    const r = parseArgs(['node', 'cli.mjs', 'research', 'topic', '--json']);
    expect(r.research?.json).toBe(true);
  });

  it('--config sets configPath', () => {
    const r = parseArgs(['node', 'cli.mjs', 'research', 'topic', '--config', '/etc/pi.env']);
    expect(r.configPath).toBe('/etc/pi.env');
  });
});

// ---------------------------------------------------------------------------
// parseArgs — unknown command
// ---------------------------------------------------------------------------

describe('parseArgs — unknown command', () => {
  it('throws UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'bogus'])).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// EXIT codes (exported constant)
// ---------------------------------------------------------------------------

describe('EXIT', () => {
  it('has expected codes', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.USAGE).toBe(64);
    expect(EXIT.CONFIG).toBe(78);
    expect(EXIT.SOFTWARE).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// Subprocess — CLI binary end-to-end (requires dist/cli.mjs to be built)
// ---------------------------------------------------------------------------

function runCli(args: string[], env?: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 20_000,
  });
}

describe('CLI subprocess — help / version', () => {
  it('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pi-research');
    expect(r.stdout).toContain('USAGE');
  });

  it('no args exits 0 and prints usage', () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('COMMANDS');
  });

  it('--version exits 0', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('CLI subprocess — bad arguments', () => {
  it('unknown command exits 64', () => {
    const r = runCli(['bogus']);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('unknown command');
  });

  it('research with no query exits 64', () => {
    const r = runCli(['research']);
    expect(r.status).toBe(64);
  });

  it('knowledge with no query exits 64', () => {
    const r = runCli(['knowledge']);
    expect(r.status).toBe(64);
  });

  it('knowledge with 6 queries exits 64', () => {
    const r = runCli(['knowledge', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(r.status).toBe(64);
  });

  it('research --depth 9 exits 64', () => {
    const r = runCli(['research', 'topic', '--depth', '9']);
    expect(r.status).toBe(64);
  });
});

describe('CLI subprocess — status', () => {
  it('status exits 0', () => {
    const r = runCli(['status']);
    expect(r.status).toBe(0);
  });

  it('status --json exits 0 and emits valid JSON', () => {
    const r = runCli(['status', '--json']);
    expect(r.status).toBe(0);
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(r.stdout); }).not.toThrow();
    expect(parsed).toHaveProperty('package', '@lincoln504/pi-research');
    expect(parsed).toHaveProperty('ready');
    expect(parsed).toHaveProperty('credentials');
    expect(parsed).toHaveProperty('paths');
  });
});

// ---------------------------------------------------------------------------
// Subprocess — skill install/uninstall end-to-end against an isolated HOME.
// Exercises the real installer through the CLI (dynamic import + manifest +
// symlink), never touching the developer's ~/.claude or ~/.pi. The symlink
// target is the repo's own skills/ dir; uninstall removes only the link.
// ---------------------------------------------------------------------------

describe('CLI subprocess — skill (hermetic agent-skill install)', () => {
  let home: string;
  let work: string;
  // Clean env: drop ambient PI_RESEARCH_* and pin HOME so the manifest
  // (~/.pi/research) and agent dirs (~/.claude …) resolve inside the sandbox.
  const env = (): Record<string, string> => {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('PI_RESEARCH_')) base[k] = v;
    }
    return { ...base, HOME: home, USERPROFILE: home };
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: 'utf-8', env: env(), timeout: 20_000 });
  const byTool = (results: Array<{ tool: string; status: string }>, tool: string) =>
    results.find((r) => r.tool === tool);

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'pir-skill-home-'));
    work = mkdtempSync(path.join(os.tmpdir(), 'pir-skill-work-'));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it('status --json lists the three target agents, none installed, in an empty HOME', () => {
    const r = run(['skill', 'status', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ command: 'skill', action: 'status' });
    expect(out.agents.map((a: { id: string }) => a.id).sort()).toEqual(['claude', 'codex', 'openclaw']);
    for (const a of out.agents) {
      expect(a.present).toBe(false);
      expect(a.installed).toBe('none');
    }
  });

  it('install with no agents present is a no-op that still exits 0 with a note', () => {
    const r = run(['skill', 'install', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/no supported coding agents/i);
  });

  it('install → status → uninstall round-trips for a detected agent (Claude)', () => {
    // The installer only targets agents whose root config dir already exists;
    // simulate a Claude setup by creating ~/.claude.
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const skillPath = path.join(home, '.claude', 'skills', 'pi-research');

    // dry-run plans but must not touch the filesystem.
    const dry = JSON.parse(run(['skill', 'install', '--dry-run', '--json']).stdout);
    expect(byTool(dry.results, 'claude')?.status).toBe('planned');
    expect(existsSync(skillPath)).toBe(false);

    // real install creates the link and the SKILL.md resolves through it.
    const inst = run(['skill', 'install', '--json']);
    expect(inst.status).toBe(0);
    expect(byTool(JSON.parse(inst.stdout).results, 'claude')?.status).toBe('installed');
    expect(existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);

    const claude = JSON.parse(run(['skill', 'status', '--json']).stdout)
      .agents.find((a: { id: string }) => a.id === 'claude');
    expect(claude.present).toBe(true);
    expect(claude.installed).toMatch(/^owned-(symlink|copy)$/);

    // uninstall removes exactly what install created.
    const un = run(['skill', 'uninstall', '--json']);
    expect(un.status).toBe(0);
    expect(byTool(JSON.parse(un.stdout).results, 'claude')?.status).toBe('removed');
    expect(existsSync(skillPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subprocess — knowledge-config end-to-end, hermetic per-directory scoping.
// Runs the built CLI against an isolated HOME + state dir so the real ~/.pi is
// never touched and results are deterministic regardless of the developer's own
// config.env. Exercises the actual persistence + precedence behavior, not mocks.
// ---------------------------------------------------------------------------

describe('CLI subprocess — knowledge-config (hermetic per-directory scoping)', () => {
  let home: string;
  let stateDir: string;
  let work: string;

  /** Build a clean environment: drop all ambient PI_RESEARCH_* and pin HOME + state dir. */
  const hermeticEnv = (extra?: Record<string, string>): Record<string, string> => {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('PI_RESEARCH_')) base[k] = v;
    }
    return { ...base, HOME: home, USERPROFILE: home, PI_RESEARCH_STATE_DIR: stateDir, ...extra };
  };
  const runIn = (dir: string, args: string[], extra?: Record<string, string>) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf-8', env: hermeticEnv(extra), timeout: 20_000 });
  const showJson = (dir: string, extra?: Record<string, string>) => {
    const r = runIn(dir, ['knowledge-config', '--json'], extra);
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
  };
  const mkdir = (name: string) => { const d = path.join(work, name); mkdirSync(d, { recursive: true }); return d; };

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'pir-kc-home-'));
    stateDir = path.join(home, 'state');
    mkdirSync(stateDir, { recursive: true });
    work = mkdtempSync(path.join(os.tmpdir(), 'pir-kc-work-'));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it('defaults to global (enabled everywhere) from the built-in default when nothing is configured', () => {
    const info = showJson(mkdir('default'));
    expect(info.mode).toBe('global');
    expect(info.origin).toBe('built-in default');
  });

  it('set persists the mode per-directory; a sibling directory is unaffected', () => {
    const a = mkdir('a');
    const b = mkdir('b');

    const set = runIn(a, ['knowledge-config', 'set', 'project', '--json']);
    expect(set.status).toBe(0);
    const setInfo = JSON.parse(set.stdout);
    expect(setInfo.saved).toBe(true);
    expect(setInfo.mode).toBe('project');
    expect(setInfo.previous).toBe('global');

    const aShow = showJson(a);
    expect(aShow.mode).toBe('project');
    expect(aShow.origin).toBe('this directory (project settings)');

    const bShow = showJson(b);        // sibling dir must NOT inherit a's override
    expect(bShow.mode).toBe('global');
    expect(bShow.origin).toBe('built-in default');
  });

  it('a per-directory setting overrides a machine-wide config.env default (bridge-fix regression guard)', () => {
    // A machine-wide 'none' default in config.env must stay a low-precedence FILE layer, not be
    // promoted into process.env — otherwise the per-directory registry could never override it.
    const researchDir = path.join(home, '.pi', 'research');
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(path.join(researchDir, 'config.env'), 'PI_RESEARCH_KNOWLEDGE_STORE_MODE=none\n');
    try {
      const c = mkdir('c');
      const before = showJson(c);
      expect(before.mode).toBe('none');
      expect(before.origin).toBe('config.env (machine-wide default)');

      const set = runIn(c, ['knowledge-config', 'set', 'global']);
      expect(set.status).toBe(0);

      const after = showJson(c);
      expect(after.mode).toBe('global'); // registry beats the config.env machine-wide default
      expect(after.origin).toBe('this directory (project settings)');
    } finally {
      rmSync(path.join(researchDir, 'config.env'), { force: true });
    }
  });

  it('persists ONLY the changed key — does not freeze DEFAULT_RESEARCH_DEPTH for the directory', () => {
    // Setting the knowledge-store mode must NOT also pin the sibling local-scope key
    // (DEFAULT_RESEARCH_DEPTH) into the registry. If it did, the directory would be silently
    // decoupled from a later machine-wide default change. Guards the wholesale-write regression.
    const researchDir = path.join(home, '.pi', 'research');
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(path.join(researchDir, 'config.env'), 'PI_RESEARCH_DEFAULT_RESEARCH_DEPTH=2\n');
    try {
      const f = mkdir('depth-scope');
      const set = runIn(f, ['knowledge-config', 'set', 'project']);
      expect(set.status).toBe(0);

      const registry = JSON.parse(readFileSync(path.join(stateDir, 'project-settings.json'), 'utf-8'));
      const entry = Object.values(registry).find(
        (v: any) => v?.PI_RESEARCH_KNOWLEDGE_STORE_MODE === 'project',
      ) as Record<string, string> | undefined;
      expect(entry).toBeDefined();
      // The mode is written; the depth is NOT (it keeps inheriting from config.env).
      expect(entry!.PI_RESEARCH_KNOWLEDGE_STORE_MODE).toBe('project');
      expect(entry!.PI_RESEARCH_DEFAULT_RESEARCH_DEPTH).toBeUndefined();
    } finally {
      rmSync(path.join(researchDir, 'config.env'), { force: true });
    }
  });

  it('a real environment variable outranks the per-directory write, and set says so', () => {
    const d = mkdir('d');
    const set = runIn(d, ['knowledge-config', 'set', 'project'], { PI_RESEARCH_KNOWLEDGE_STORE_MODE: 'none' });
    expect(set.status).toBe(0);
    expect(set.stdout).toMatch(/higher-precedence environment variable/);
    const info = showJson(d, { PI_RESEARCH_KNOWLEDGE_STORE_MODE: 'none' });
    expect(info.mode).toBe('none');
    expect(info.origin).toBe('environment variable');
  });

  it('set with an invalid mode exits 64', () => {
    const r = runIn(mkdir('e'), ['knowledge-config', 'set', 'bogus']);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('invalid knowledge store mode');
  });
});

// ---------------------------------------------------------------------------
// Subprocess — skill launcher (run.mjs)
// ---------------------------------------------------------------------------

function runSkill(args: string[]) {
  return spawnSync(process.execPath, [SKILL_LAUNCHER, ...args], {
    encoding: 'utf-8',
    timeout: 20_000,
  });
}

describe('skill launcher subprocess', () => {
  it('no args prints usage and exits 0', () => {
    const r = runSkill([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('research skill');
  });

  it('--help exits 0', () => {
    const r = runSkill(['--help']);
    expect(r.status).toBe(0);
  });

  it('status chains to CLI and exits 0', () => {
    const r = runSkill(['status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pi-research');
  });

  it('status --json returns valid JSON via launcher', () => {
    const r = runSkill(['status', '--json']);
    expect(r.status).toBe(0);
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(r.stdout); }).not.toThrow();
    expect(parsed).toHaveProperty('ready');
  });

  it('bad args propagate correct exit code through launcher', () => {
    const r = runSkill(['research']);
    expect(r.status).toBe(64);
  });
});

