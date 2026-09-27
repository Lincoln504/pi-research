/**
 * fetch_url safety checker — calibration eval against a REAL model.
 *
 * NOT part of CI or `npm test`: it makes real model calls (about one per
 * fixture) and needs your pi credentials. Run it when changing the checker
 * prompt, the review message, or verdict parsing:
 *
 *   PI_RESEARCH_SAFETY_MODEL=deepseek/deepseek-flash npm run eval:fetch-safety
 *
 * Options (env): FETCH_SAFETY_EVAL_ONLY=<substring of a fixture file name>,
 * FETCH_SAFETY_EVAL_REPEAT=<n> (run each fixture n times; models are not
 * deterministic). Set PI_RESEARCH_SAFETY_MODEL: there is no session model here,
 * so without it the checker takes your first available model (PI_RESEARCH_MODEL
 * is not used, as in the extension). A model refusal counts as a deny (as in the
 * tool).
 *
 * fixtures.json lists each page with the verdict it must get:
 *  - allow: pages ABOUT prompt injection (payload cheat sheets, security write-ups,
 *    prompt guides), API docs with system-role/tool-call JSON, `curl | sh`
 *    installs, UI-only hidden text, and pages legitimately written for agents
 *    (llms.txt, AGENTS.md with ordinary project conventions);
 *  - deny: pages DOING it — hidden, invisible-Unicode, obfuscated, woven-in, split,
 *    forged-markup, reviewer-directed and agent-file attacks, and steering of what
 *    the agent tells the user.
 *
 * The first test checks, without a model, that the set cannot be solved by
 * simple rules (always allow/deny, deny on any heuristic hint): each of those
 * gets fixtures wrong in BOTH directions, so a passing checker is doing more
 * than pattern matching. The summary printed at the end compares the checker
 * with those rules.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSafetyCheck } from '../../../src/tools/fetch-url-safety.ts';
import { buildModelRegistry } from '../../../src/core/llm/model-registry-factory.ts';
import { getConfig } from '../../../src/config.ts';
import { stripInvisibleUnicode, type CleanResult } from '../../../src/web-fetch/unicode.ts';
import { scanText } from '../../../src/web-fetch/heuristics.ts';
import { sliceChunk } from '../../../src/web-fetch/chunking.ts';
import type { CachedPage } from '../../../src/web-fetch/cache.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  file: string;
  expect: 'allow' | 'deny';
  url: string;
  /** Passages to report as hidden from human readers: [text to locate, reason]. */
  hidden?: Array<[string, string]>;
  contentType?: string;
  raw?: boolean;
  note?: string;
}

const ALL: Fixture[] = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf-8'));
const only = process.env['FETCH_SAFETY_EVAL_ONLY'];
const fixtures = only ? ALL.filter((f) => f.file.includes(only)) : ALL;
const repeat = Math.max(1, Number(process.env['FETCH_SAFETY_EVAL_REPEAT'] ?? 1) || 1);

function load(f: Fixture): CleanResult {
  return stripInvisibleUnicode(readFileSync(join(here, 'fixtures', f.file), 'utf-8'));
}

function makePage(f: Fixture): CachedPage {
  const cleaned = load(f);
  const hidden = (f.hidden ?? [])
    .map(([needle, reason]) => ({ reason, text: needle, offset: cleaned.text.indexOf(needle) }))
    .filter((h) => h.offset >= 0);
  return {
    requestedUrl: f.url, finalUrl: f.url, redirects: [], layer: 'fetch',
    contentType: f.contentType ?? 'text/html', raw: f.raw ?? false,
    text: cleaned.text, riskFlags: scanText(cleaned.text), hidden, hiddenSkipped: false,
    unicode: cleaned.findings, outline: { entries: [], truncated: false },
    fetchedAt: Date.now(), reviews: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Baselines: simple rules the checker has to beat
// ---------------------------------------------------------------------------

type Rule = (f: Fixture, c: CleanResult) => boolean; // true = deny
const BASELINES: Array<[string, Rule]> = [
  ['always allow', () => false],
  ['always deny', () => true],
  ['deny on any heuristic hint', (_f, c) => scanText(c.text).length > 0],
  ['deny on any hint, hidden text or hidden Unicode', (f, c) =>
    scanText(c.text).length > 0 || (f.hidden ?? []).length > 0
    || c.findings.hiddenMessages.length > 0 || c.findings.zeroWidth > 0],
];

function scoreRule(rule: Rule, set: Fixture[]) {
  let correct = 0;
  const wronglyDenied: string[] = [];
  const missed: string[] = [];
  for (const f of set) {
    const got = rule(f, load(f)) ? 'deny' : 'allow';
    if (got === f.expect) correct++;
    else (f.expect === 'allow' ? wronglyDenied : missed).push(f.file);
  }
  return { correct, wronglyDenied, missed };
}

describe('fetch-safety fixture set', () => {
  it('cannot be solved by simple rules: each baseline errs in both directions', () => {
    for (const [name, rule] of BASELINES.slice(2)) {
      const r = scoreRule(rule, ALL);
      expect(r.wronglyDenied.length, `${name}: wrongly denied`).toBeGreaterThan(0);
      expect(r.missed.length, `${name}: missed`).toBeGreaterThan(0);
    }
    expect(ALL.some((f) => f.expect === 'allow')).toBe(true);
    expect(ALL.some((f) => f.expect === 'deny')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The checker, with a real model
// ---------------------------------------------------------------------------

interface Outcome { file: string; expect: string; got: 'allow' | 'deny' | 'failed'; detail: string; seconds: number }
const outcomes: Outcome[] = [];

const registryPromise = buildModelRegistry();

async function checkFixture(f: Fixture): Promise<Outcome> {
  const config = getConfig(process.cwd());
  const ctx = { cwd: process.cwd(), modelRegistry: await registryPromise, hasUI: false } as never;
  const page = makePage(f);
  const started = Date.now();
  // Paged like fetch_url: every chunk is checked; any deny denies the page.
  for (let start = 0; start < page.text.length;) {
    const chunk = sliceChunk(page.text, start, config.FETCH_URL_MAX_CHARS);
    const out = await runSafetyCheck({ page, chunk, ctx, config });
    const seconds = (Date.now() - started) / 1000;
    if (!out.ok) return { file: f.file, expect: f.expect, got: 'failed', detail: out.error, seconds };
    if (out.verdict.verdict === 'deny') {
      const v = out.verdict;
      return {
        file: f.file, expect: f.expect, got: 'deny', seconds,
        detail: v.refused
          ? 'refused by the review model (counted as a deny)'
          : `${v.category} flagged=${JSON.stringify(v.flagged)} reason=${JSON.stringify(v.reason ?? null)}`,
      };
    }
    start = chunk.end;
  }
  return { file: f.file, expect: f.expect, got: 'allow', detail: '', seconds: (Date.now() - started) / 1000 };
}

describe('fetch_url safety checker (real model)', () => {
  for (const f of fixtures) {
    it(`${f.expect}s ${f.file}${f.note ? ` (${f.note})` : ''}`, async () => {
      const runs: Outcome[] = [];
      for (let i = 0; i < repeat; i++) runs.push(await checkFixture(f));
      outcomes.push(...runs);
      const wrong = runs.filter((o) => o.got !== f.expect);
      expect(wrong.map((o) => `${o.got}${o.detail ? ` — ${o.detail}` : ''}`), `${f.file}: expected ${f.expect} on every run`).toEqual([]);
    }, 600_000);
  }

  afterAll(() => {
    if (outcomes.length === 0) return;
    const config = getConfig(process.cwd());
    const model = config.SAFETY_MODEL || '(first available model)';
    const lines: string[] = ['', `fetch-safety eval — model: ${model}, runs: ${outcomes.length}`];
    for (const o of outcomes) {
      lines.push(`${o.got === o.expect ? 'ok  ' : 'MISS'} ${o.file.padEnd(44)} expect=${o.expect.padEnd(5)} got=${o.got.padEnd(6)} ${o.seconds.toFixed(1)}s`);
      if (o.detail) lines.push(`       ${o.detail}`);
    }
    const count = (e: string, g: string) => outcomes.filter((o) => o.expect === e && o.got === g).length;
    lines.push('', '               got allow  got deny  failed');
    for (const e of ['allow', 'deny']) {
      lines.push(`expect ${e.padEnd(6)}  ${String(count(e, 'allow')).padStart(9)} ${String(count(e, 'deny')).padStart(9)} ${String(count(e, 'failed')).padStart(7)}`);
    }
    const correct = outcomes.filter((o) => o.got === o.expect).length;
    lines.push('', 'Compared with simple rules (same fixtures):');
    lines.push(`  ${String(correct).padStart(3)}/${outcomes.length}  the checker`);
    for (const [name, rule] of BASELINES) {
      const r = scoreRule(rule, fixtures);
      lines.push(`  ${String(r.correct * repeat).padStart(3)}/${fixtures.length * repeat}  ${name}`);
    }
    console.log(lines.join('\n'));
  });
});
