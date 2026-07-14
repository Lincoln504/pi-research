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
import { parseArgs, UsageError, EXIT, reportError } from '../../src/cli.ts';
import { createResearchStopError } from '../../src/orchestration/session-state.ts';

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

describe('reportError — exit-code classification', () => {
  // Regression (ISSUES-ANALYSIS-2026-07-09.md, Symptom 3b): every "Research
  // stopped" message carries generic boilerplate advice containing the literal
  // substring "API key", which used to make the substring heuristic below
  // misclassify every fail-fast research stop as a config error (exit 78) —
  // even when the real cause was worker-pool contention with nothing wrong
  // with the model or credentials.
  it('classifies a tagged research-stop error as SOFTWARE even though its message contains "API key"', () => {
    const err = createResearchStopError('session-1', 'research-1');
    expect(err.message.toLowerCase()).toContain('api key');
    const exitCode = reportError(err, 'research', true);
    expect(exitCode).toBe(EXIT.SOFTWARE);
  });

  it('still classifies a genuine, untagged credentials error as CONFIG', () => {
    const exitCode = reportError(new Error('Invalid API key provided'), 'research', true);
    expect(exitCode).toBe(EXIT.CONFIG);
  });

  it('still classifies a rate-limit error as SOFTWARE (operational, not a setup problem)', () => {
    const exitCode = reportError(new Error('429 rate limit exceeded for this api key'), 'research', true);
    expect(exitCode).toBe(EXIT.SOFTWARE);
  });

  it('classifies an unrelated runtime error as SOFTWARE', () => {
    const exitCode = reportError(new Error('Worker pool is shutting down'), 'research', true);
    expect(exitCode).toBe(EXIT.SOFTWARE);
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
// Subprocess — a configured model is REQUIRED on the pi-credentials path.
// The standalone CLI / agent skill never follow the model selected inside the
// pi extension; with auth.json present but no PI_RESEARCH_MODEL the run must
// fail fast (exit 78, pre-flight) instead of silently picking the registry's
// first authed model.
// ---------------------------------------------------------------------------

describe('CLI subprocess — model required with pi credentials', () => {
  let home: string;
  const env = (extra: Record<string, string> = {}): Record<string, string> => {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('PI_RESEARCH_')) base[k] = v;
    }
    return { ...base, HOME: home, USERPROFILE: home, ...extra };
  };
  const run = (args: string[], extra?: Record<string, string>) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', env: env(extra), timeout: 20_000 });

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'pir-model-home-'));
    mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    // A real credential entry (matches pi's auth.json shape) — an empty `{}`
    // deliberately does NOT count as keys (see the empty-auth test below).
    writeFileSync(
      path.join(home, '.pi', 'agent', 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'sk-test' } }) + '\n',
      'utf-8'
    );
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('research fails fast with exit 78 when auth.json exists but no model is configured', () => {
    const r = run(['research', 'some topic']);
    expect(r.status).toBe(EXIT.CONFIG);
    expect(r.stderr).toContain('no research model is configured');
    expect(r.stderr).toContain('PI_RESEARCH_MODEL');
  });

  it('status --json reports ready:false with the model problem', () => {
    const r = run(['status', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ready).toBe(false);
    expect(out.credentials.problem).toMatch(/no research model is configured/i);
  });

  it('setting PI_RESEARCH_MODEL makes detection ready again', () => {
    // Model provider must match the authed provider (openai here): detection
    // is provider-aware, so an arbitrary provider would rightly stay not-ready.
    const r = run(['status', '--json'], { PI_RESEARCH_MODEL: 'openai/gpt-4o' });
    const out = JSON.parse(r.stdout);
    expect(out.ready).toBe(true);
    expect(out.credentials.model).toBe('openai/gpt-4o');
    expect(out.credentials.modelFrom).toBe('PI_RESEARCH_MODEL');
  });

  it('a key for a DIFFERENT provider does not greenlight the configured model', () => {
    // auth.json has an openai entry; the model names a provider with no key
    // anywhere. Pre-flight must say not-ready instead of passing and dying on
    // the first LLM call with "No API key found".
    const r = run(['status', '--json'], { PI_RESEARCH_MODEL: 'keyless-provider/some-model' });
    const out = JSON.parse(r.stdout);
    expect(out.ready).toBe(false);
  });

  // --model pre-flight participation. The whitespace-only query is the hermetic
  // probe: query validation (exit 64) runs AFTER credential pre-flight (exit 78),
  // so exit 64 proves the pre-flight passed without starting a real run.
  it('an explicit --model satisfies the model-required pre-flight on its own', () => {
    // Regression: cmdResearch used to run detectCredentials() before ever
    // consulting args.model, so a valid key + `--model` still died with
    // "no research model is configured".
    const r = run(['research', '   ', '--model', 'openai/gpt-4o']);
    expect(r.status).toBe(EXIT.USAGE); // got past pre-flight, failed on the query
    expect(r.stderr).not.toContain('no research model is configured');
  });

  it('provider-aware pre-flight keys off the --model provider, not the configured one', () => {
    // A keyless provider on the FLAG must fail pre-flight even though a valid
    // openai key exists…
    const bad = run(['research', '   ', '--model', 'keyless-provider/some-model']);
    expect(bad.status).toBe(EXIT.CONFIG);
    // …and a keyed provider on the flag must pass pre-flight even when the
    // CONFIGURED model names a keyless provider (the flag outranks it).
    const good = run(['research', '   ', '--model', 'openai/gpt-4o'], {
      PI_RESEARCH_MODEL: 'keyless-provider/some-model',
    });
    expect(good.status).toBe(EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Subprocess — key detection reads pi's configuration CONTENT, not file
// presence: an empty auth.json is not keys; an embedded models.json
// providers.*.apiKey IS keys even with no auth.json at all (mirrors pi's
// registry, which reads auth.json entry ?? providers[name].apiKey at call time).
// ---------------------------------------------------------------------------

describe('CLI subprocess — pi key detection by content', () => {
  const env = (home: string): Record<string, string> => {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Strip research vars AND provider env keys (OPENAI_API_KEY, GITHUB_TOKEN, …):
      // pi's hasAuth() honors provider env vars, so an ambient key on the dev/CI
      // machine would make the empty-auth case falsely "available".
      if (v !== undefined && !k.startsWith('PI_RESEARCH_') && !/_API_KEY$/.test(k) && !/_TOKEN$/.test(k)) base[k] = v;
    }
    return { ...base, HOME: home, USERPROFILE: home, PI_RESEARCH_MODEL: 'some-provider/some-model' };
  };
  const status = (home: string) =>
    JSON.parse(spawnSync(process.execPath, [CLI, 'status', '--json'], { encoding: 'utf-8', env: env(home), timeout: 20_000 }).stdout);

  it('an EMPTY auth.json (and no models.json keys) is not credentials — reports the no-key problem', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pir-emptyauth-'));
    try {
      mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
      writeFileSync(path.join(home, '.pi', 'agent', 'auth.json'), '{}\n', 'utf-8');
      const out = status(home);
      expect(out.ready).toBe(false);
      expect(out.credentials.source).toBe('none');
      expect(out.credentials.problem).toMatch(/No model or API key/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('an embedded models.json apiKey counts as credentials even with NO auth.json', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pir-modelskey-'));
    try {
      mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
      // A custom provider needs at least one model for pi's registry to expose
      // anything "available" — mirrors a real models.json entry.
      writeFileSync(
        path.join(home, '.pi', 'agent', 'models.json'),
        JSON.stringify({
          providers: {
            'some-provider': {
              baseUrl: 'https://x.invalid',
              api: 'openai-completions',
              apiKey: 'sk-embedded',
              models: [{ id: 'some-model' }],
            },
          },
        }) + '\n',
        'utf-8'
      );
      const out = status(home);
      expect(out.ready).toBe(true);
      expect(out.credentials.source).toBe('pi-config');
      expect(out.credentials.apiKeyConfigured).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
  const run = (args: string[], extra?: Record<string, string>) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: 'utf-8', env: { ...env(), ...extra }, timeout: 20_000 });
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

  it('install points at the required model config when none is set', () => {
    // The sandbox HOME has no config.env and PI_RESEARCH_* is stripped, so the
    // install output must carry the model-configuration note (and the JSON form
    // must report modelConfigured:false). ~/.claude exists from the round-trip
    // test above, so the install actually proceeds.
    const human = run(['skill', 'install', '--dry-run']);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('PI_RESEARCH_MODEL=provider/model-id');
    expect(human.stdout).toContain('runs only on this configured model');

    const json = JSON.parse(run(['skill', 'install', '--dry-run', '--json']).stdout);
    expect(json.modelConfigured).toBe(false);

    // With a model configured the note disappears.
    const configured = run(['skill', 'install', '--dry-run'], { PI_RESEARCH_MODEL: 'prov/id' });
    expect(configured.stdout).not.toContain('PI_RESEARCH_MODEL=provider/model-id');
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

