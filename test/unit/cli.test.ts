/**
 * CLI unit tests — parseArgs + subprocess integration.
 *
 * parseArgs tests exercise the argument-parsing logic directly (pure function,
 * no I/O). Subprocess tests verify the CLI binary's end-to-end behaviour for
 * paths that can run without a live model (help, version, bad args).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mocks for the cmdResearch / cmdKnowledge / cmdKnowledgeConfig unit coverage
// further below. sdk.ts is fully replaced — cli.ts only ever touches these 6
// named exports, and the real module pulls in the embedding/orchestration
// stack that these tests must never spin up. config.ts keeps its REAL
// implementation (via importOriginal): only saveConfig is swapped for a
// controllable stub, so getConfig/resetConfig/describeKnowledgeStoreMode
// behave exactly as they do for every other command in this file.
// ---------------------------------------------------------------------------
const {
  mockInitResearchSDK,
  mockRunDeepResearch,
  mockSearchKnowledge,
  mockShutdownResearchSDK,
  mockGetLastErrorReport,
  mockGetLastResearcherOutcome,
  mockSaveConfig,
} = vi.hoisted(() => ({
  mockInitResearchSDK: vi.fn(async () => {}),
  mockRunDeepResearch: vi.fn(async () => 'mock report body'),
  mockSearchKnowledge: vi.fn(async () => ({
    text: 'mock knowledge text',
    found: 'yes' as const,
    documentsSearched: 1,
    citations: [] as string[],
  })),
  mockShutdownResearchSDK: vi.fn(async () => {}),
  mockGetLastErrorReport: vi.fn(() => null),
  mockGetLastResearcherOutcome: vi.fn(() => null),
  mockSaveConfig: vi.fn(),
}));

vi.mock('../../src/sdk.ts', () => ({
  initResearchSDK: mockInitResearchSDK,
  runDeepResearch: mockRunDeepResearch,
  searchKnowledge: mockSearchKnowledge,
  shutdownResearchSDK: mockShutdownResearchSDK,
  getLastErrorReport: mockGetLastErrorReport,
  getLastResearcherOutcome: mockGetLastResearcherOutcome,
}));

vi.mock('../../src/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.ts')>();
  return { ...actual, saveConfig: mockSaveConfig };
});

// ---------------------------------------------------------------------------
// parseArgs (unit)
// ---------------------------------------------------------------------------

// Guard: skip mocked-module bleed from other test files by importing after
// all vi.mock() calls.  parseArgs and UsageError are pure — no side effects
// on import because the _isMain guard prevents top-level execution.
import {
  parseArgs,
  UsageError,
  EXIT,
  reportError,
  exitCodeForSignal,
  _resetCancellationLatchForTests,
  _markCancellationForTests,
  _signalDisposition,
  _resetSignalDispositionForTests,
  cmdResearch,
  cmdKnowledge,
  cmdKnowledgeConfig,
} from '../../src/cli.ts';
import { createResearchStopError } from '../../src/orchestration/session-state.ts';
import { ResearchRunCapacityError } from '../../src/infrastructure/research-run-semaphore.ts';
import { resetConfig } from '../../src/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist', 'cli.mjs');
const SKILL_LAUNCHER = path.join(ROOT, 'skills', 'pi-research', 'scripts', 'run.mjs');

// The subprocess suites below spawn the BUILT artifacts (dist/cli.mjs and the
// skill launcher run.mjs). These are produced by `npm run prepare` on install,
// but a CI job that restores a node_modules cache HIT skips `npm ci` (and thus
// `prepare`), leaving dist/ absent. Build on demand if missing so the suite is
// self-sufficient regardless of cache state — locally and in CI — instead of
// failing with an opaque "module not found" from the spawned node process.
//
// SUBPROCESS_HOME: throwaway HOME shared by runCli/runSkill below. main() runs
// reconcileSkillInstalls() for every command except help/version, so a CLI (or
// launcher-chained CLI) spawned with the real process.env would silently
// retarget the developer's actual skill symlinks (~/.claude/skills/…) and
// rewrite the real manifest (~/.pi/research/installed-skills.json) on every
// `npm test`. Suites that need a POPULATED sandbox HOME (auth.json,
// config.env, …) build their own tmp home instead.
let SUBPROCESS_HOME: string;

beforeAll(() => {
  SUBPROCESS_HOME = mkdtempSync(path.join(os.tmpdir(), 'pir-cli-home-'));
  if (!existsSync(CLI) || !existsSync(SKILL_LAUNCHER)) {
    execSync('npm run build:cli && npm run build:skill', { cwd: ROOT, stdio: 'inherit' });
  }
}, 120_000);

afterAll(() => {
  rmSync(SUBPROCESS_HOME, { recursive: true, force: true });
});

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

  // Regression: the ad-hoc rest.includes('--json') accepted anything — a typo'd
  // `status --jsn` (or `--json=true`) exited 0 with human output instead of
  // failing fast at exit 64 like every other subcommand.
  it('status --jsn (unknown option) → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'status', '--jsn'])).toThrow(UsageError);
  });

  it('status --json=true (not the supported form) → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'status', '--json=true'])).toThrow(UsageError);
  });

  it('status stray positional → UsageError', () => {
    expect(() => parseArgs(['node', 'cli.mjs', 'status', 'extra'])).toThrow(UsageError);
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

  it('--depth rejects a value that only STARTS with a valid integer', () => {
    // parseInt scans a leading prefix: '2x' read as 2 and '2.9' as 2, so a typo
    // silently ran a different depth than the one typed while the error text
    // claimed only "an integer 0–3" was accepted.
    for (const bad of ['2x', '2.9', '0.5', '1e1', '+2', '-1', '3abc', '']) {
      expect(() =>
        parseArgs(['node', 'cli.mjs', 'research', 'topic', '--depth', bad]),
        `--depth ${JSON.stringify(bad)}`,
      ).toThrow(UsageError);
    }
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
      'security_search,stackexchange',
    ]);
    expect(r.research?.excludeTools).toEqual(['security_search', 'stackexchange']);
  });

  it('--exclude-tools accepts read (hardening exclusion that predates validation)', () => {
    // Regression-of-the-fix: the first validator omitted `read`, breaking a
    // capability the CLI had always had — removing researchers' local-file reads.
    const r = parseArgs(['node', 'cli.mjs', 'research', 'topic', '--exclude-tools', 'read,grep']);
    expect(r.research?.excludeTools).toEqual(['read', 'grep']);
  });

  it('--exclude-tools rejects unknown tool names', () => {
    // Regression: the downstream merge is a blind Set union, so a typo — this
    // test's own previous fixture used "security" for a tool actually named
    // "security_search" — silently excluded nothing for the whole billed run.
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'research', 'topic', '--exclude-tools', 'securty_search']),
    ).toThrow(/unknown tool name "securty_search"/);
  });

  it('--initial-links with no URLs → UsageError', () => {
    // Regression: a bare --initial-links silently proceeded with zero links,
    // unlike every other value-taking flag.
    expect(() =>
      parseArgs(['node', 'cli.mjs', 'research', 'topic', '--initial-links', '--json']),
    ).toThrow(/--initial-links requires at least one URL/);
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
  it('classifies a tagged research-stop error as SOFTWARE even though its message contains "API key"', async () => {
    const err = createResearchStopError('session-1', 'research-1');
    expect(err.message.toLowerCase()).toContain('api key');
    const exitCode = await reportError(err, 'research', true);
    expect(exitCode).toBe(EXIT.SOFTWARE);
  });

  it('still classifies a genuine, untagged credentials error as CONFIG', async () => {
    const exitCode = await reportError(new Error('Invalid API key provided'), 'research', true);
    expect(exitCode).toBe(EXIT.CONFIG);
  });

  it('still classifies a rate-limit error as SOFTWARE (operational, not a setup problem)', async () => {
    const exitCode = await reportError(new Error('429 rate limit exceeded for this api key'), 'research', true);
    expect(exitCode).toBe(EXIT.SOFTWARE);
  });

  it('classifies an unrelated runtime error as SOFTWARE', async () => {
    const exitCode = await reportError(new Error('Worker pool is shutting down'), 'research', true);
    expect(exitCode).toBe(EXIT.SOFTWARE);
  });

  // Run-cap exhaustion means "the machine is busy with other healthy runs", which
  // a caller must be able to tell apart from "this run crashed" — otherwise an
  // agent retries a perfectly-fine install as though it were broken, or gives up.
  it('classifies run-cap exhaustion as TEMPFAIL, not SOFTWARE', async () => {
    const err = new ResearchRunCapacityError(3, 600_000);
    const exitCode = await reportError(err, 'research', true);
    expect(exitCode).toBe(EXIT.TEMPFAIL);
    expect(EXIT.TEMPFAIL).not.toBe(EXIT.SOFTWARE);
  });

  // A deliberate stop is not a fault. Reported as SOFTWARE (70) it matched the
  // skill contract's "runtime error — suggest one retry", so an agent relaying the
  // result would offer to re-run the research the user had just interrupted.
  describe('cancellation', () => {
    afterEach(() => _resetCancellationLatchForTests());

    it.each([
      ['Aborted'],
      ['Research aborted'],
      ['Research cancelled'],
    ])('classifies a programmatic abort (%s) as CANCELLED, not SOFTWARE', async (message) => {
      const exitCode = await reportError(new Error(message), 'research', true);
      expect(exitCode).toBe(EXIT.CANCELLED);
      expect(EXIT.CANCELLED).not.toBe(EXIT.SOFTWARE);
    });

    it('does NOT classify a bare AbortError as cancellation without the latch or the exact signatures', async () => {
      // Internal timeout aborts (AbortSignal-driven retry/scrape deadlines) throw
      // name === 'AbortError' too. In the CLI every real cancellation sets the
      // signal latch or carries the anchored signatures — an escaped internal
      // abort must NOT report "cancelled — do not re-run" for a run nobody stopped.
      const err = new Error('The operation was aborted because of some provider detail');
      err.name = 'AbortError';
      expect(await reportError(err, 'research', true)).toBe(EXIT.SOFTWARE);
    });

    it('reports the SAME 128+N as the signal path when the latch carries the signal', async () => {
      // reportError races onSignal's own flushAndExit; latching the signal name
      // makes both racers agree (SIGTERM → 143 from either), and keeps --json's
      // exitCode field from contradicting the actual exit status.
      _markCancellationForTests('SIGTERM');
      expect(await reportError(new Error('Invalid API key provided'), 'research', true)).toBe(143);
    });

    it('reports a cancellation as cancelled, not as the component that noticed the abort', async () => {
      // A Ctrl-C unwinding through the planner surfaces internally as
      // "Coordinator failed: Request was aborted". The plain-text branch already
      // refuses to say "failed" for a deliberate stop, but the --json `error`
      // carried that raw wording — and SKILL.md instructs agents to relay these
      // messages, so the user was told a component broke when they had simply
      // stopped the run. The diagnostic wording must survive, under `cause`.
      _markCancellationForTests();
      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        out.push(String(chunk));
        return true;
      });
      try {
        await reportError(new Error('Coordinator failed: Request was aborted'), 'research', true);
      } finally {
        spy.mockRestore();
      }
      const payload = JSON.parse(out.join(''));
      expect(payload.error).toBe('pi-research research cancelled.');
      expect(payload.error).not.toMatch(/failed/i);
      expect(payload.cause).toBe('Coordinator failed: Request was aborted');
      expect(payload).toMatchObject({ ok: false, cancelled: true, exitCode: EXIT.CANCELLED });
    });

    it('leaves a NON-cancellation error message untouched (no cause field)', async () => {
      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        out.push(String(chunk));
        return true;
      });
      try {
        await reportError(new Error('Worker pool is shutting down'), 'research', true);
      } finally {
        spy.mockRestore();
      }
      const payload = JSON.parse(out.join(''));
      expect(payload.error).toBe('Worker pool is shutting down');
      expect(payload.cause).toBeUndefined();
      expect(payload.cancelled).toBeUndefined();
    });

    it('never marks a cancelled capacity error retryable', async () => {
      // Ctrl-C landing in the same window a queue-wait expires: the payload must
      // not carry retryable:true alongside cancelled:true, or a consumer re-runs
      // the research the user just stopped.
      _markCancellationForTests();
      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        out.push(String(chunk));
        return true;
      });
      try {
        await reportError(new ResearchRunCapacityError(3, 600_000), 'research', true);
      } finally {
        spy.mockRestore();
      }
      const payload = JSON.parse(out.join(''));
      expect(payload).toMatchObject({ ok: false, exitCode: EXIT.CANCELLED, cancelled: true });
      expect(payload.retryable).toBeUndefined();
    });

    it('marks the --json payload cancelled rather than retryable', async () => {
      const out: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        out.push(String(chunk));
        return true;
      });
      try {
        await reportError(new Error('Aborted'), 'research', true);
      } finally {
        spy.mockRestore();
      }
      const payload = JSON.parse(out.join(''));
      expect(payload).toMatchObject({ ok: false, exitCode: EXIT.CANCELLED, cancelled: true });
      expect(payload.retryable).toBeUndefined();
    });

    // An abort can unwind through an in-flight provider call and surface with that
    // call's wording. The classifier must not then read it as a setup problem or a
    // rate limit and send the user off reconfiguring a working install.
    it('wins over the config and rate-limit heuristics once a signal was received', async () => {
      _markCancellationForTests();
      expect(await reportError(new Error('Invalid API key provided'), 'research', true)).toBe(EXIT.CANCELLED);
      expect(await reportError(new Error('429 rate limit exceeded'), 'research', true)).toBe(EXIT.CANCELLED);
    });

    it('does not swallow ordinary failures when no cancellation occurred', async () => {
      expect(await reportError(new Error('Worker pool is shutting down'), 'research', true)).toBe(EXIT.SOFTWARE);
      expect(await reportError(new Error('Invalid API key provided'), 'research', true)).toBe(EXIT.CONFIG);
    });
  });

  // The CLI installs handlers for these signals, so it is never actually killed by
  // them — it catches them and exits deliberately. Emitting a FIXED code would make
  // the status a wrapper observes depend on whether our handler beat a force-kill
  // (handler wins → fixed code, handler loses → the shell's 128+N). Deriving 128+N
  // makes the handler transparent: the same user action reports the same number
  // either way. Every value must also stay inside 0-255, or a POSIX wait status
  // truncates it — 256 would become a false success.
  describe('exitCodeForSignal — POSIX 128+N', () => {
    it.each([
      ['SIGHUP', 129],
      ['SIGINT', 130],
      ['SIGQUIT', 131],
      ['SIGTERM', 143],
    ] as const)('%s → %i', (sig, expected) => {
      expect(exitCodeForSignal(sig)).toBe(expected);
    });

    it('falls back to CANCELLED for a signal this platform does not define', () => {
      expect(exitCodeForSignal('SIGNOTAREALSIGNAL' as NodeJS.Signals)).toBe(EXIT.CANCELLED);
    });

    it('never produces a code outside 0-255 (a POSIX wait status would truncate it)', () => {
      for (const sig of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'] as const) {
        const code = exitCodeForSignal(sig);
        expect(code).toBeGreaterThan(128);
        expect(code).toBeLessThanOrEqual(255);
      }
    });
  });

  // The capacity message names PI_RESEARCH_MAX_CONCURRENT_RUNS; the config
  // heuristic must not read that as a credentials problem and send the user off
  // to reconfigure a working install.
  it('does not misclassify the capacity message as a CONFIG error', async () => {
    const err = new ResearchRunCapacityError(3, 0);
    const exitCode = await reportError(err, 'research', true);
    expect(exitCode).not.toBe(EXIT.CONFIG);
  });

  it('marks capacity exhaustion retryable in --json output', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await reportError(new ResearchRunCapacityError(3, 600_000), 'research', true);
    } finally {
      spy.mockRestore();
    }
    const payload = JSON.parse(writes.join(''));
    expect(payload).toMatchObject({ ok: false, exitCode: EXIT.TEMPFAIL, retryable: true });
  });
});

// ---------------------------------------------------------------------------
// Signal disposition — duplicate absorption vs force exit
// ---------------------------------------------------------------------------

describe('_signalDisposition — duplicate absorption vs force exit', () => {
  afterEach(() => _resetSignalDispositionForTests());

  it('the first cancelling signal begins cleanup', () => {
    expect(_signalDisposition(1_000_000)).toBe('begin-cleanup');
  });

  it("absorbs the launcher's forwarded duplicate (arrives within ms of the tty's group-wide delivery)", () => {
    // With stdio:'inherit' the engine sits in the tty foreground group, so a
    // Ctrl-C delivers SIGINT directly AND the launcher forwards its own copy
    // milliseconds later. Pre-fix the process.once handler was CONSUMED by the
    // first delivery, so the duplicate hit the default disposition and killed
    // the engine instantly — mid-safeShutdown, skipping browser/embedder teardown.
    expect(_signalDisposition(1_000_000)).toBe('begin-cleanup');
    expect(_signalDisposition(1_000_005)).toBe('absorb-duplicate');
  });

  it('a repeat WELL after the first (a human at a stuck cleanup) force-exits', () => {
    expect(_signalDisposition(1_000_000)).toBe('begin-cleanup');
    expect(_signalDisposition(1_001_500)).toBe('force-exit');
  });

  it('the force-exit window is anchored to the FIRST signal, not re-armed by duplicates', () => {
    expect(_signalDisposition(1_000_000)).toBe('begin-cleanup');
    expect(_signalDisposition(1_000_900)).toBe('absorb-duplicate');
    expect(_signalDisposition(1_001_100)).toBe('force-exit');
  });
});

// ---------------------------------------------------------------------------
// cmdResearch — cancellation reporting (mocked SDK)
// ---------------------------------------------------------------------------

// DeepResearchOrchestrator.run() does not throw on cancellation once at least
// one researcher has produced a report — it returns the fallback synthesis
// through its NORMAL return path (deep-research-orchestrator.ts, the
// synthesisService.hasReports(researchId) branch ~584-618). cmdResearch's
// success branch used to be blind to the cancellation latch the SIGINT/SIGTERM
// handler sets, so a Ctrl-C mid-run that still produced a report was reported
// exactly like an ordinary completed run: ok:true, exit 0, no `cancelled` flag.
describe('cmdResearch — cancellation reporting', () => {
  const ENV_KEYS = ['PI_RESEARCH_API_KEY', 'PI_RESEARCH_PROVIDER', 'PI_RESEARCH_MODEL', 'PI_RESEARCH_REPORT_EXPORT_ENABLED'];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // Explicit-env credential path (see detectCredentials): a provider-qualified
    // model + an API key satisfy the pre-flight regardless of the machine's own
    // ambient pi/config.env setup.
    process.env['PI_RESEARCH_API_KEY'] = 'test-key';
    process.env['PI_RESEARCH_PROVIDER'] = 'mock-provider';
    process.env['PI_RESEARCH_MODEL'] = 'mock-provider/mock-model';
    // Force the file-export side effect off regardless of ambient config — this
    // test must never touch the filesystem.
    process.env['PI_RESEARCH_REPORT_EXPORT_ENABLED'] = 'false';
    resetConfig();
    mockRunDeepResearch.mockClear();
    mockRunDeepResearch.mockResolvedValue('partial report from fallback synthesis');
    // safeShutdown() races shutdownResearchSDK() against an 8s setTimeout; fake
    // timers keep that timer from actually pending for real wall-clock seconds
    // after the (already-mocked, immediately-resolving) shutdown wins the race.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetConfig();
    _resetCancellationLatchForTests();
  });

  it('reports ok:true + cancelled:true + the signalled exit code — not a bare ok:true/exit 0 — when a cancellation was latched before runDeepResearch resolved', async () => {
    // Simulates the real sequence: onSignal() latches cancellation and aborts
    // the run's AbortController, then the orchestrator returns its fallback
    // report through the normal (non-throwing) return path.
    _markCancellationForTests('SIGTERM');

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    let exitCode: number;
    try {
      exitCode = await cmdResearch({ query: 'what is rust ownership', json: true });
    } finally {
      spy.mockRestore();
    }

    // Must mirror reportError's own formula for the throwing case (143 for
    // SIGTERM), not the flat EXIT.OK (0) the current bug emits.
    expect(exitCode).toBe(exitCodeForSignal('SIGTERM'));
    expect(exitCode).not.toBe(EXIT.OK);
    const payload = JSON.parse(out.join(''));
    expect(payload).toMatchObject({
      ok: true,
      cancelled: true,
      report: 'partial report from fallback synthesis',
    });
  });

  it('does not set cancelled or change the exit code for an ordinary completed run', async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    let exitCode: number;
    try {
      exitCode = await cmdResearch({ query: 'what is rust ownership', json: true });
    } finally {
      spy.mockRestore();
    }
    expect(exitCode).toBe(EXIT.OK);
    const payload = JSON.parse(out.join(''));
    expect(payload.ok).toBe(true);
    expect(payload.cancelled).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cmdKnowledge — cancellation reporting
// ---------------------------------------------------------------------------

// cmdKnowledge used to call searchKnowledge() with no AbortSignal at all, so
// onSignal's activeResearchAbortController.abort() had nothing to reach — a
// Ctrl-C during a knowledge search only raced safeShutdown() against the
// still-running, unsignaled search. Same bug class the cmdResearch suite
// above covers, one call site earlier: verify the signal is actually threaded
// through, and that a cancellation surfaced as a rejection is classified via
// reportError's latch rather than reported as an ordinary failure.
describe('cmdKnowledge — cancellation reporting', () => {
  const ENV_KEYS = ['PI_RESEARCH_API_KEY', 'PI_RESEARCH_PROVIDER', 'PI_RESEARCH_MODEL', 'PI_RESEARCH_KNOWLEDGE_STORE_MODE'];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env['PI_RESEARCH_API_KEY'] = 'test-key';
    process.env['PI_RESEARCH_PROVIDER'] = 'mock-provider';
    process.env['PI_RESEARCH_MODEL'] = 'mock-provider/mock-model';
    process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'] = 'global';
    resetConfig();
    mockSearchKnowledge.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetConfig();
    _resetCancellationLatchForTests();
  });

  it('passes a real AbortSignal into searchKnowledge so onSignal can actually reach it', async () => {
    mockSearchKnowledge.mockResolvedValue({
      text: 'mock knowledge text', found: 'yes' as const, documentsSearched: 1, citations: [],
    });
    await cmdKnowledge(['what is rust'], true);
    expect(mockSearchKnowledge).toHaveBeenCalledTimes(1);
    const signalArg = (mockSearchKnowledge.mock.calls[0] as unknown as [string[], AbortSignal])[1];
    expect(signalArg).toBeInstanceOf(AbortSignal);
    expect(signalArg.aborted).toBe(false);
  });

  it('classifies a cancellation-shaped rejection via the latch instead of an ordinary failure', async () => {
    // Simulates the real sequence: onSignal() latches cancellation and would
    // abort this run's signal; research-knowledge-search.ts re-throws once it
    // observes an aborted signal rather than returning a stale result.
    _markCancellationForTests('SIGTERM');
    mockSearchKnowledge.mockRejectedValue(new Error('Aborted'));

    const exitCode = await cmdKnowledge(['what is rust'], true);

    expect(exitCode).toBe(exitCodeForSignal('SIGTERM'));
    expect(exitCode).not.toBe(EXIT.OK);
  });
});

// ---------------------------------------------------------------------------
// cmdKnowledge — --json payload shape
// ---------------------------------------------------------------------------

// Both the success shape and the "store disabled" shape used to omit `ok`
// entirely, even though reportError's own --json error branch claims (in a
// comment) to mirror an `{ ok: true, ... }` success shape — it didn't, because
// knowledge's success payload never set it. `ok` must be a reliable
// success/failure discriminant across every knowledge --json variant.
describe('cmdKnowledge — --json payload shape', () => {
  const ENV_KEYS = ['PI_RESEARCH_API_KEY', 'PI_RESEARCH_PROVIDER', 'PI_RESEARCH_MODEL', 'PI_RESEARCH_KNOWLEDGE_STORE_MODE'];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env['PI_RESEARCH_API_KEY'] = 'test-key';
    process.env['PI_RESEARCH_PROVIDER'] = 'mock-provider';
    process.env['PI_RESEARCH_MODEL'] = 'mock-provider/mock-model';
    mockSearchKnowledge.mockClear();
    mockSearchKnowledge.mockResolvedValue({
      text: 'mock knowledge text',
      found: 'yes' as const,
      documentsSearched: 2,
      citations: ['https://example.com'],
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetConfig();
  });

  it('success payload includes ok:true alongside the existing KnowledgeSearchResult fields', async () => {
    process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'] = 'global';
    resetConfig();
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await cmdKnowledge(['what is rust'], true);
    } finally {
      spy.mockRestore();
    }
    const payload = JSON.parse(out.join(''));
    expect(payload).toMatchObject({
      ok: true,
      found: 'yes',
      documentsSearched: 2,
      text: 'mock knowledge text',
    });
  });

  it("disabled-store payload includes ok:true — it's a successful 'not configured' response, not an error", async () => {
    process.env['PI_RESEARCH_KNOWLEDGE_STORE_MODE'] = 'none';
    resetConfig();
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await cmdKnowledge(['what is rust'], true);
    } finally {
      spy.mockRestore();
    }
    const payload = JSON.parse(out.join(''));
    expect(payload).toMatchObject({ ok: true, found: 'no', configured: false });
  });
});

// ---------------------------------------------------------------------------
// cmdKnowledgeConfig — --json error contract
// ---------------------------------------------------------------------------

// cmdKnowledgeConfig had no try/catch at all: a thrown error (e.g. saveConfig
// failing to write the per-directory registry) escaped straight past this
// function to main()'s top-level catch, which ALWAYS writes plain text to
// stderr regardless of --json — silently breaking the documented
// `--json: Emit a JSON object` contract for this one subcommand.
describe('cmdKnowledgeConfig — --json error contract', () => {
  afterEach(() => {
    mockSaveConfig.mockReset();
  });

  it('emits a JSON {ok:false, error} object on stdout when saveConfig throws, instead of letting the error escape uncaught', async () => {
    mockSaveConfig.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, write');
    });
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(String(chunk));
      return true;
    });
    let thrown: unknown = null;
    let exitCode: number | undefined;
    try {
      exitCode = await cmdKnowledgeConfig({ action: 'set', mode: 'global', json: true });
    } catch (err) {
      thrown = err;
    } finally {
      spy.mockRestore();
    }

    // Pre-fix, cmdKnowledgeConfig had no try/catch: the rejection above would
    // land in `thrown`, not in a --json payload — proving the escape.
    expect(thrown).toBeNull();
    expect(exitCode).not.toBe(EXIT.OK);
    const payload = JSON.parse(out.join(''));
    expect(payload.ok).toBe(false);
    expect(typeof payload.error).toBe('string');
    expect(payload.error).toContain('ENOSPC');
  });
});

// ---------------------------------------------------------------------------
// Subprocess — CLI binary end-to-end (requires dist/cli.mjs to be built)
// ---------------------------------------------------------------------------

// Scrubbed env + throwaway HOME — the same hermetic treatment the
// model-required suite uses: ambient PI_RESEARCH_* must not steer detection,
// and HOME/USERPROFILE must never be the developer's real ones (see the
// SUBPROCESS_HOME note above the beforeAll).
function hermeticEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('PI_RESEARCH_')) base[k] = v;
  }
  return { ...base, HOME: SUBPROCESS_HOME, USERPROFILE: SUBPROCESS_HOME, ...extra };
}

function runCli(args: string[], env?: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: hermeticEnv(env),
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

  it('status --jsn (typo) exits 64 naming the valid options', () => {
    const r = runCli(['status', '--jsn']);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('--jsn');
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
// Subprocess — an EXPLICIT --config file must exist and be readable.
// Regression: bridgeConfigEnv treated the named file with the same tolerance as
// the optional ambient layers, so a typo'd `--config /path/ci.evn` silently ran
// on ambient config and reported success. Ambient tolerance (a missing
// config.env/cli.env) must stay unchanged — the status tests above prove that.
// ---------------------------------------------------------------------------

describe('CLI subprocess — explicit --config must exist and be readable', () => {
  it('a missing explicit --config exits 78 naming the path, on every command that accepts it', () => {
    const missing = path.join(SUBPROCESS_HOME, 'no-such-dir', 'ci.evn');
    for (const args of [
      ['status', '--config', missing],
      ['research', 'topic', '--config', missing],
      ['knowledge', 'topic', '--config', missing],
      ['knowledge-config', '--config', missing],
    ]) {
      const r = runCli(args);
      expect(r.status, `command: ${args[0]}`).toBe(EXIT.CONFIG);
      expect(r.stderr, `command: ${args[0]}`).toContain(missing);
    }
  });

  it('an unreadable explicit --config exits 78 (POSIX permissions)', () => {
    // chmod 0 is meaningless on Windows and a no-op for root.
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const p = path.join(SUBPROCESS_HOME, 'unreadable.env');
    writeFileSync(p, 'PI_RESEARCH_MODEL=prov/id\n', { mode: 0o000 });
    try {
      const r = runCli(['status', '--config', p]);
      expect(r.status).toBe(EXIT.CONFIG);
      expect(r.stderr).toContain(p);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it('an existing, readable explicit --config still applies (status stays 0)', () => {
    const p = path.join(SUBPROCESS_HOME, 'ok.env');
    writeFileSync(p, 'PI_RESEARCH_MODEL=prov/id\n', 'utf-8');
    try {
      const r = runCli(['status', '--json', '--config', p]);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).credentials.model).toBe('prov/id');
    } finally {
      rmSync(p, { force: true });
    }
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
      // The fixture env DOES configure a model (PI_RESEARCH_MODEL), so the
      // precise gap is "model set, key missing" — the message must name that,
      // not the conflated "No model or API key" it previously showed.
      expect(out.credentials.problem).toMatch(/model is configured .* no API key is available/i);
      expect(out.credentials.problem).toContain('some-provider');
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

  it('status in a pi-less HOME creates NO ~/.pi directory (read-only-safe pre-flight)', () => {
    // Regression guard for the pi 0.80.8 ModelRuntime migration: the runtime's
    // default file-backed credential store creates ~/.pi/agent/auth.json at
    // CONSTRUCTION, so without the in-memory store in buildModelRegistry every
    // CLI invocation — including read-only `status` — would silently create a
    // pi config dir on machines that never installed pi, and hard-fail where
    // $HOME is read-only.
    const home = mkdtempSync(path.join(os.tmpdir(), 'pir-noside-'));
    try {
      const r = spawnSync(process.execPath, [CLI, 'status', '--json'], {
        encoding: 'utf-8', env: env(home), timeout: 20_000,
      });
      expect(r.status).toBe(0);
      expect(existsSync(path.join(home, '.pi'))).toBe(false);
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
  // Hermetic like runCli: `status` chains through the launcher into the real
  // CLI, which reconciles skill installs against $HOME (see SUBPROCESS_HOME).
  return spawnSync(process.execPath, [SKILL_LAUNCHER, ...args], {
    encoding: 'utf-8',
    env: hermeticEnv(),
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

  it('forwards a signal aimed at the launcher to the engine instead of orphaning it', async () => {
    // POSIX signal delivery — Windows has no kill(2) semantics to test here.
    if (process.platform === 'win32') return;
    // A harness enforcing its command timeout SIGTERMs the LAUNCHER pid, not the
    // process group. Pre-fix, the launcher died with 143 while the engine kept
    // researching for minutes, holding a machine-wide run slot and the browser
    // pool. The stub engine records its pid and idles until signalled.
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'pi-launcher-sig-'));
    const pidFile = path.join(workDir, 'engine.pid');
    const stubPath = path.join(workDir, 'stub-engine');
    writeFileSync(
      stubPath,
      [
        '#!/usr/bin/env node',
        "require('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));",
        "process.on('SIGTERM', () => process.exit(143));",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      { mode: 0o755 },
    );
    try {
      const launcher = spawn(process.execPath, [SKILL_LAUNCHER, 'research', 'test query'], {
        // hermeticEnv scrubs ambient PI_RESEARCH_*; the stub-engine override is
        // deliberate and re-added on top.
        env: hermeticEnv({ PI_RESEARCH_BIN: stubPath, PID_FILE: pidFile }),
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((resolve) => launcher.on('exit', (code) => resolve(code)));

      // Wait for the stub engine to come up and record its pid.
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(pidFile)).toBe(true);
      const enginePid = Number(readFileSync(pidFile, 'utf-8'));

      launcher.kill('SIGTERM'); // the launcher ONLY — not the group, not the engine
      expect(await Promise.race([
        exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000)),
      ])).toBe(143);

      // The engine must be gone shortly after — signal 0 probes existence.
      const engineDeadline = Date.now() + 5_000;
      let engineAlive = true;
      while (engineAlive && Date.now() < engineDeadline) {
        try { process.kill(enginePid, 0); await new Promise((r) => setTimeout(r, 50)); }
        catch { engineAlive = false; }
      }
      expect(engineAlive).toBe(false);
    } finally {
      // Belt-and-braces: never leave a stub engine behind, even on assertion failure.
      try { process.kill(Number(readFileSync(pidFile, 'utf-8')), 'SIGKILL'); } catch { /* already gone */ }
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});

