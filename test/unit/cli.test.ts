/**
 * CLI unit tests — parseArgs + subprocess integration.
 *
 * parseArgs tests exercise the argument-parsing logic directly (pure function,
 * no I/O). Subprocess tests verify the CLI binary's end-to-end behaviour for
 * paths that can run without a live model (help, version, bad args).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
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
    timeout: 10_000,
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
// Subprocess — skill launcher (run.mjs)
// ---------------------------------------------------------------------------

const SKILL_LAUNCHER = path.join(ROOT, 'skills', 'research', 'scripts', 'run.mjs');

function runSkill(args: string[]) {
  return spawnSync(process.execPath, [SKILL_LAUNCHER, ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
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
