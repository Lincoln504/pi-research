/**
 * Contract test for the knowledge-search prompting gate.
 *
 * The host agent (esp. weaker models like glm-4.7) was skipping the knowledge
 * store for bare "research X" prompts. The fix strengthens research-tool-usage.md
 * to MANDATE a knowledge-search-first workflow, gated on a store being enabled —
 * index.ts strips the whole KNOWLEDGE SEARCH block when no store is available.
 *
 * This test pins both halves of that contract: the strengthened wording is
 * present, and the strip regex (kept identical to index.ts) removes exactly the
 * knowledge block while leaving the rest of the prompt intact.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// MUST stay identical to the regex in src/index.ts (before_agent_start handler).
const KNOWLEDGE_BLOCK_STRIP = /\n\*\*KNOWLEDGE SEARCH[\s\S]*?\n---\n/m;

const PROMPT = readFileSync(
  join(__dirname, '../../../src/prompts/research-tool-usage.md'),
  'utf-8',
);

describe('research-tool-usage knowledge-search gate', () => {
  it('directs knowledge search first, intentionally but without heavy emphasis', () => {
    expect(PROMPT).toMatch(/\*\*KNOWLEDGE SEARCH/);
    expect(PROMPT).toMatch(/Check the knowledge store first/);
    expect(PROMPT).toMatch(/before the live `research` tool/);
    // The exact behaviour the user reported missing: a bare "research X" must
    // still check the store first.
    expect(PROMPT).toMatch(/bare "research X" request still starts here/i);
    // Tone: keep it measured — no shouty MANDATORY/no-exceptions framing.
    expect(PROMPT).not.toMatch(/MANDATORY/);
    expect(PROMPT).not.toMatch(/no exceptions/i);
  });

  it('the strip regex removes the whole knowledge block when no store is enabled', () => {
    expect(PROMPT).toMatch(KNOWLEDGE_BLOCK_STRIP);

    const stripped = PROMPT.replace(KNOWLEDGE_BLOCK_STRIP, '\n---\n');

    // Knowledge block gone...
    expect(stripped).not.toMatch(/KNOWLEDGE SEARCH/);
    expect(stripped).not.toMatch(/research_knowledge_search/);
    // ...but the rest of the guidance survives.
    expect(stripped).toMatch(/RESEARCH TOOL USAGE/);
    expect(stripped).toMatch(/DEPTH PARAMETER/);
    expect(stripped).toMatch(/What counts as web research\?/);
    // No doubled separators introduced by the replacement.
    expect(stripped).not.toMatch(/\n---\n---\n/);
  });
});
