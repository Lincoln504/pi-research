/**
 * Regression tests: tool output must never contain clickable hyperlinks.
 *
 * pi's TUI (and any markdown renderer) turns `[text](url)` links and bare
 * URLs (GFM autolink) into OSC 8 terminal hyperlinks — a mouse click on one
 * opens the URL in the user's real browser. Tool output is agent-facing
 * data, so every URL pi-research emits must be neutralized (code-spanned),
 * and third-party content (question/answer bodies) must be fenced so its
 * embedded markdown can neither autolink nor inject formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  formatQuestionsCompact,
} from '../../../../src/stackexchange/output/compact';
import {
  formatQuestionsTable,
  formatAnswersTable,
  formatUsersTable,
  formatCompactQuestions,
} from '../../../../src/stackexchange/output/table';
import { plainUrl, fenceBlock } from '../../../../src/utils/plain-url';

/** Matches markdown links `[text](url)` — the clickable hazard. */
const MD_LINK = /\[[^\]\n]*\]\([^)\s]*\)/;

/** Strip inert regions (code spans, fenced blocks) so the hazard scan only
 *  covers what a renderer would actually turn into a hyperlink. */
function clickableSurface(text: string): string {
  return text
    .replace(/```[a-z]*\n[\s\S]*?\n```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

const q = {
  title: 'How do I exit vim?',
  link: 'https://stackoverflow.com/q/11828270',
  score: 25,
  answer_count: 4,
  view_count: 900,
  accepted_answer_id: 1,
  tags: ['vim'],
  creation_date: 1600000000,
  body: 'Read the [docs](https://vimhelp.org) or run `:q!`.',
} as any;

const a = {
  score: 10,
  is_accepted: true,
  question_id: 11828270,
  creation_date: 1600000001,
  body: 'See https://vim.fandom.com/wiki/Ctrl-C — that also works.',
  owner: { display_name: 'Ingo', reputation: 5 },
} as any;

const u = {
  display_name: 'Guru',
  reputation: 999,
  badge_counts: { gold: 1, silver: 2, bronze: 3 },
  user_id: 7,
  creation_date: 1500000000,
  website_url: 'https://guru.example.com',
  link: 'https://stackoverflow.com/users/7/guru',
} as any;

describe('tool outputs contain no clickable hyperlinks', () => {
  it.each([
    ['formatQuestionsCompact', () => formatQuestionsCompact([q])],
    ['formatCompactQuestions', () => formatCompactQuestions([q])],
    ['formatQuestionsTable', () => formatQuestionsTable([q])],
    ['formatAnswersTable', () => formatAnswersTable([a])],
    ['formatUsersTable', () => formatUsersTable([u])],
  ])('%s: no markdown links in output', (_name, fn) => {
    expect(clickableSurface(fn())).not.toMatch(MD_LINK);
  });

  it.each([
    ['formatQuestionsCompact', () => formatQuestionsCompact([q]), 'https://stackoverflow.com/q/11828270'],
    ['formatCompactQuestions', () => formatCompactQuestions([q]), 'https://stackoverflow.com/q/11828270'],
    ['formatQuestionsTable', () => formatQuestionsTable([q]), 'https://stackoverflow.com/q/11828270'],
    ['formatUsersTable', () => formatUsersTable([u]), 'https://stackoverflow.com/users/7/guru'],
  ])('%s: URLs preserved and code-spanned', (_name, fn, url) => {
    const result = fn();
    expect(result).toContain(`\`${url}\``);
  });

  it('question body is fenced — embedded links are inert', () => {
    const result = formatQuestionsTable([q]);
    expect(result).toContain('```text');
    // The link survives as DATA inside the fence, but the clickable surface
    // (everything outside code spans/fences) carries none.
    expect(result).toContain('https://vimhelp.org');
    expect(clickableSurface(result)).not.toMatch(MD_LINK);
  });

  it('question-body fence starts on its own line (CommonMark validity)', () => {
    // Inline fences ("- **Body:** ```text") are NOT recognized as code
    // blocks by CommonMark renderers — verified: pi's bundled marked renders
    // the embedded markdown link clickable in that placement.
    const result = formatQuestionsTable([q]);
    expect(result).toMatch(/^```text$/m);
  });

  it('renders with zero clickable links through the real renderer (end-to-end)', async () => {
    // marked is pi's actual markdown renderer (a transitive dep here — skip
    // gracefully if hoisting changes). Definitive check: render the actual
    // formatter output and assert the HTML contains no anchor elements.
    let parse: ((s: string) => string) | undefined;
    try {
      const m = await import('marked');
      // marked.parse has overloads that confuse .bind's typing — wrap instead.
      const raw = m.marked.parse as (s: string) => string;
      parse = (s: string) => raw(s);
    } catch {
      return; // not hoisted — structural tests above still hold
    }
    const outputs = [
      formatQuestionsTable([q]),
      formatAnswersTable([a]),
      formatUsersTable([u]),
      formatQuestionsCompact([q]),
      formatCompactQuestions([q]),
    ];
    for (const out of outputs) {
      expect(parse(out)).not.toContain('<a ');
    }
  });

  it('answer body is fenced — embedded bare URLs are inert', () => {
    const result = formatAnswersTable([a]);
    expect(result).toContain('```text');
    expect(result).toContain('https://vim.fandom.com/wiki/Ctrl-C');
    expect(clickableSurface(result)).not.toMatch(MD_LINK);
  });

  it('user website + profile are code-spanned', () => {
    const result = formatUsersTable([u]);
    expect(result).toContain('- **Website:** `https://guru.example.com`');
    expect(result).toContain('- **Profile:** `https://stackoverflow.com/users/7/guru`');
  });
});

describe('plainUrl', () => {
  it('wraps URL in a code span', () => {
    expect(plainUrl('https://x.com/q')).toBe('`https://x.com/q`');
  });

  it('neutralizes backticks inside the URL so the span cannot be broken', () => {
    expect(plainUrl('https://x.com/q`a')).toBe('`https://x.com/q%60a`');
  });
});

describe('fenceBlock', () => {
  it('uses a fence longer than any backtick run in the content', () => {
    const sneaky = '```\nclick me\n```';
    const out = fenceBlock(sneaky);
    expect(out.startsWith('````text\n')).toBe(true);
    expect(out.endsWith('\n````')).toBe(true);
  });

  it('uses the minimum fence for plain content', () => {
    expect(fenceBlock('hello')).toBe('```text\nhello\n```');
  });
});
