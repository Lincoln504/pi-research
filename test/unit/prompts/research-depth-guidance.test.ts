/**
 * Contract test for buildResearchDepthGuidance (PR #16, discussion point 2).
 *
 * The agent-facing research tool-usage prompt must render its DEPTH PARAMETER
 * guidance relative to the user's configured DEFAULT_RESEARCH_DEPTH. The hard
 * acceptance condition (the green-light comment on PR #16): depth 1 stays the
 * default setting, so every install whose effective default is 1 — the default
 * install (quick off) and quick-on-with-default-1 — must render BYTE-IDENTICAL
 * to the prior static text.
 *
 * effectiveDefault = quickEnabled ? defaultDepth : max(1, defaultDepth)
 *   (the depth execute() applies when the agent omits depth — see
 *   research-tool-definition.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildResearchDepthGuidance, buildEscalationNudge, resolveEffectiveDefault } from '../../../src/prompts/research-depth-guidance.ts';

// --- The prior static text, captured byte-for-byte, keyed by effective default 1 ---

const WORD_BLOCK_1 =
  '**User says a depth word (highest priority):**\n' +
  '- "quick" / "brief" / "simple" → `depth: 1`\n' +
  '- "normal" / "moderate" / "standard" → `depth: 1`\n' +
  '- "deep" / "thorough" / "in-depth" → `depth: 2` (never depth 3)\n' +
  '- "ultra" / "exhaustive" / "comprehensive" / "deep-dive" / "maximum" → `depth: 3`';

const NOTHING_BLOCK_1 =
  '**User says nothing about depth — judge complexity:**\n' +
  '- `depth: 1` — Simple facts, lookups, news, definitions, "what is X", overviews, background research. This covers ~95%+ of queries.\n' +
  '- `depth: 2` — Complex multi-faceted topics: policy analysis, tech evaluations, academic-style research.\n' +
  '- `depth: 3` — **ABSOLUTELY NEVER without explicit user request.** The user MUST use trigger words like "ultra", "exhaustive", "comprehensive deep-dive", or "maximum research". If the user does not explicitly request this level, use depth 1 or depth 2.';

const QUICK_DOC_1 =
  '**Depth 0 (quick) is available on this host.** Use `depth: 0` for a single verifiable fact, a URL, a price, a version number, or a yes/no with a source — or when the user says "just check", "one-liner", or "don\'t overdo it". It runs one search-and-read pass with no researcher team and answers concisely.\n\n' +
  '`depth: 1` remains the normal choice. `depth: 2` is the escalation for complex or multi-faceted questions; `depth: 3` only on explicit request.';

describe('buildResearchDepthGuidance — byte identity at effective default 1', () => {
  it('quick OFF, default 1 (the default install) is unchanged', () => {
    expect(buildResearchDepthGuidance(false, 1)).toBe(WORD_BLOCK_1 + '\n\n' + NOTHING_BLOCK_1);
  });

  it('quick OFF, default 0 clamps to 1 and is unchanged (depth 0 is not advertised)', () => {
    expect(buildResearchDepthGuidance(false, 0)).toBe(buildResearchDepthGuidance(false, 1));
    expect(buildResearchDepthGuidance(false, 0)).not.toMatch(/depth: 0/);
  });

  it('quick ON, default 1 is unchanged', () => {
    expect(buildResearchDepthGuidance(true, 1)).toBe(QUICK_DOC_1 + '\n' + WORD_BLOCK_1 + '\n\n' + NOTHING_BLOCK_1);
  });
});

describe('buildResearchDepthGuidance — relative to the configured default', () => {
  it('quick ON, default 0 makes depth 0 the ordinary choice and 1+ the escalation', () => {
    const out = buildResearchDepthGuidance(true, 0);
    // "quick" now resolves to the user's configured default (0).
    expect(out).toMatch('- "quick" / "brief" / "simple" → `depth: 0`');
    // The ordinary choice is depth 0; depth 1 is the first escalation.
    expect(out).toMatch('- `depth: 0` — the ordinary choice:');
    expect(out).toMatch('- `depth: 1` — Coordinated, thorough research:');
    expect(out).toMatch('`depth: 0` is the ordinary choice');
    expect(out).toMatch('`depth: 1` is the escalation');
    // Depth 3 stays explicit-request-only.
    expect(out).toMatch(/ABSOLUTELY NEVER without explicit user request/);
  });

  it('quick ON, default 2 anchors the guidance at depth 2', () => {
    const out = buildResearchDepthGuidance(true, 2);
    expect(out).toMatch('- "quick" / "brief" / "simple" → `depth: 1`');
    expect(out).toMatch('- `depth: 2` — the ordinary choice (your configured default):');
    expect(out).toMatch('`depth: 2` is the ordinary choice');
  });

  it('quick ON, default 3 anchors the guidance at depth 3', () => {
    const out = buildResearchDepthGuidance(true, 3);
    expect(out).toMatch('- `depth: 3` — the ordinary choice (your configured default):');
    expect(out).toMatch('`depth: 3` is the ordinary choice');
  });

  it('never advertises a depth the schema cannot accept', () => {
    // Quick off: depth 0 is unreachable, so the guidance must not name it.
    expect(buildResearchDepthGuidance(false, 0)).not.toMatch(/depth: 0/);
    expect(buildResearchDepthGuidance(false, 1)).not.toMatch(/depth: 0/);
  });

  it('returns a string with no leading or trailing newlines (the template supplies the blank lines)', () => {
    for (const [q, d] of [[false, 0], [false, 1], [true, 0], [true, 1], [true, 2], [true, 3]] as Array<[boolean, number]>) {
      const out = buildResearchDepthGuidance(q, d);
      expect(out.startsWith('\n')).toBe(false);
      expect(out.endsWith('\n')).toBe(false);
    }
  });
});

const NUDGE_1 = 'depth 1 handles most cases well, and the higher depths have their own internal decomposition.';
const NUDGE_CONFIGURED = 'your configured default handles most cases well, and the higher depths have their own internal decomposition.';

describe('buildEscalationNudge — relative to the effective default', () => {
  it('effective default 1 reproduces the prior static text (quick off and quick on)', () => {
    expect(buildEscalationNudge(false, 1)).toBe(NUDGE_1);
    expect(buildEscalationNudge(true, 1)).toBe(NUDGE_1);
  });

  it('non-default effective defaults name the configured default instead of depth 1', () => {
    for (const [q, d] of [[true, 0], [false, 2], [false, 3], [true, 2], [true, 3]] as Array<[boolean, number]>) {
      expect(buildEscalationNudge(q, d)).toBe(NUDGE_CONFIGURED);
    }
  });

  it('quick off, default 0 clamps to 1 like the guidance does', () => {
    expect(buildEscalationNudge(false, 0)).toBe(NUDGE_1);
  });
});

describe('resolveEffectiveDefault — matches the depth execute() applies to an omitted depth', () => {
  it('is max(depthMin, configured) where depthMin = quickEnabled ? 0 : 1', () => {
    expect(resolveEffectiveDefault(false, 0)).toBe(1);
    expect(resolveEffectiveDefault(false, 1)).toBe(1);
    expect(resolveEffectiveDefault(false, 2)).toBe(2);
    expect(resolveEffectiveDefault(false, 3)).toBe(3);
    expect(resolveEffectiveDefault(true, 0)).toBe(0);
    expect(resolveEffectiveDefault(true, 1)).toBe(1);
    expect(resolveEffectiveDefault(true, 2)).toBe(2);
    expect(resolveEffectiveDefault(true, 3)).toBe(3);
  });
});

// End-to-end: mirror index.ts's substitution against the real template and confirm
// the rendered DEPTH PARAMETER section is byte-identical at effective default 1.
describe('rendered DEPTH PARAMETER section (template integration)', () => {
  const md = readFileSync(join(__dirname, '../../../src/prompts/research-tool-usage.md'), 'utf-8');

  function renderedDepthSection(quick: boolean, def: number): string {
    let p = md
      .replace('{{DEPTH_GUIDANCE}}', buildResearchDepthGuidance(quick, def))
      .replace('{{max_team_size_l1}}', '2')
      .replace('{{max_team_size_l2}}', '3')
      .replace('{{max_team_size_l3}}', '5');
    p = p.replace(/\n\*\*KNOWLEDGE SEARCH[\s\S]*?\n---\n/m, '\n---\n');
    const a = p.indexOf('task complexity.');
    const b = p.indexOf('**How depth works internally:**');
    return p.slice(a, b).replace(/^task complexity\.\n\n/, '').replace(/\n\n$/, '');
  }

  it('quick OFF, default 1 renders byte-identically to the prior text', () => {
    expect(renderedDepthSection(false, 1)).toBe(WORD_BLOCK_1 + '\n\n' + NOTHING_BLOCK_1);
  });

  it('quick ON, default 1 renders byte-identically to the prior text', () => {
    expect(renderedDepthSection(true, 1)).toBe(QUICK_DOC_1 + '\n' + WORD_BLOCK_1 + '\n\n' + NOTHING_BLOCK_1);
  });

  const renderedEscalationLine = (quick: boolean, def: number): string =>
    md
      .replace('{{DEPTH_GUIDANCE}}', buildResearchDepthGuidance(quick, def))
      .replace('{{ESCALATION_NUDGE}}', buildEscalationNudge(quick, def))
      .split('\n')
      .find((l) => l.startsWith('**Do NOT escalate'))!;

  it('Do NOT escalate line renders byte-identically to the prior text at effective default 1', () => {
    const prior = '**Do NOT escalate depth just because a topic is broad** — depth 1 handles most cases well, and the higher depths have their own internal decomposition.';
    expect(renderedEscalationLine(false, 1)).toBe(prior);
    expect(renderedEscalationLine(true, 1)).toBe(prior);
  });

  it('Do NOT escalate line names the configured default at non-default effective defaults', () => {
    for (const [quick, def] of [[true, 0], [false, 2], [true, 3]] as Array<[boolean, number]>) {
      expect(renderedEscalationLine(quick, def)).toContain('your configured default handles most cases well');
    }
  });
});
