/**
 * Renders the DEPTH PARAMETER guidance for the agent-facing `research` tool,
 * relative to the user's configured `DEFAULT_RESEARCH_DEPTH`.
 *
 * Background (PR #16, discussion point 2): the tool-usage prompt says
 * "Always specify a depth" and mapped ~95% of queries to `depth: 1`, so a
 * user-configured default (e.g. quick/0) was effectively never honored for
 * agent-initiated research — even with quick set as the default the agent
 * still sent `depth: 1`. This builder renders the guidance relative to the
 * configured default: when quick is the configured default, depth 0 becomes
 * the ordinary choice and depth 1+ reads as the escalation. A user who keeps
 * the default (1) sees byte-identical guidance — quality-first behavior is
 * unchanged.
 *
 * The anchor is the *effective* default — the depth `execute()` actually
 * resolves an omitted depth to:
 *
 *     effectiveDefault = quickEnabled ? defaultDepth : Math.max(1, defaultDepth)
 *
 * Depth 0 is only reachable when quick mode is enabled; otherwise a
 * configured 0 clamps to 1 at runtime, so the guidance must not advertise it.
 *
 * This is a pure function of the two session-static snapshots the tool schema
 * was built from (see quickResearchEnabledAtRegistration /
 * defaultDepthAtRegistration in index.ts) so the rendered guidance can never
 * advertise a depth the registered schema rejects.
 */

/**
 * Build the DEPTH PARAMETER guidance block (everything between the
 * "Always specify a depth." lead-in and the "How depth works internally:"
 * section). The returned string has no leading or trailing newlines; the
 * caller's template supplies the surrounding blank lines.
 *
 * @param quickEnabled Whether quick mode (depth 0) is enabled — the same
 *   session-static snapshot the tool schema was built from.
 * @param defaultDepth The user-configured `DEFAULT_RESEARCH_DEPTH` (0–3).
 */
export function buildResearchDepthGuidance(quickEnabled: boolean, defaultDepth: number): string {
  // The depth execute() applies when the agent omits depth. This is "the
  // ordinary choice" the guidance steers to.
  const effectiveDefault = quickEnabled ? defaultDepth : Math.max(1, defaultDepth);

  if (!quickEnabled) {
    return wordBlock(effectiveDefault) + '\n\n' + nothingBlock(effectiveDefault);
  }
  return quickDoc(effectiveDefault) + '\n' + wordBlock(effectiveDefault) + '\n\n' + nothingBlock(effectiveDefault);
}

/**
 * The "user says a depth word" mapping. Byte-identical for effectiveDefault in
 * {1,2,3}; only the "quick" line moves — to 0 — when the configured default IS
 * 0. "normal" stays 1: the words form a shallow→max scale
 * (quick < normal < deep < ultra = 0 < 1 < 2 < 3), so "normal" is always the
 * standard orchestrated run.
 */
function wordBlock(effectiveDefault: number): string {
  const quickTarget = effectiveDefault === 0 ? 0 : 1;
  return [
    '**User says a depth word (highest priority):**',
    '- "quick" / "brief" / "simple" → `depth: ' + quickTarget + '`',
    '- "normal" / "moderate" / "standard" → `depth: 1`',
    '- "deep" / "thorough" / "in-depth" → `depth: 2` (never depth 3)',
    '- "ultra" / "exhaustive" / "comprehensive" / "deep-dive" / "maximum" → `depth: 3`',
  ].join('\n');
}

/**
 * The "user says nothing about depth — judge complexity:" section. Positions
 * the effective default as the ordinary choice. effectiveDefault === 1
 * reproduces the prior static text byte-for-byte.
 */
function nothingBlock(effectiveDefault: number): string {
  const header = '**User says nothing about depth — judge complexity:**';
  const never = '- `depth: 3` — **ABSOLUTELY NEVER without explicit user request.** The user MUST use trigger words like "ultra", "exhaustive", "comprehensive deep-dive", or "maximum research".';
  switch (effectiveDefault) {
    case 0:
      return [
        header,
        '- `depth: 0` — the ordinary choice: a single verifiable fact, a URL, a price, a version number, or a yes/no with a source. One search-and-read pass, no researcher team.',
        '- `depth: 1` — Coordinated, thorough research: simple facts with sources, lookups, overviews, background research. Escalate here when the question needs more than a single verifiable fact.',
        '- `depth: 2` — Complex multi-faceted topics: policy analysis, tech evaluations, academic-style research.',
        never + ' If the user does not explicitly request this level, use depth 0, 1, or 2.',
      ].join('\n');
    case 2:
      return [
        header,
        '- `depth: 1` — Simple facts, lookups, news, definitions, "what is X", overviews, background research.',
        '- `depth: 2` — the ordinary choice (your configured default): complex multi-faceted topics, policy analysis, tech evaluations, academic-style research.',
        never,
      ].join('\n');
    case 3:
      return [
        header,
        '- `depth: 1` — Simple facts, lookups, news, definitions, "what is X", overviews, background research.',
        '- `depth: 2` — Complex multi-faceted topics: policy analysis, tech evaluations, academic-style research.',
        '- `depth: 3` — the ordinary choice (your configured default): comprehensive, multi-round, exhaustive research.',
      ].join('\n');
    case 1:
    default:
      return [
        header,
        '- `depth: 1` — Simple facts, lookups, news, definitions, "what is X", overviews, background research. This covers ~95%+ of queries.',
        '- `depth: 2` — Complex multi-faceted topics: policy analysis, tech evaluations, academic-style research.',
        never + ' If the user does not explicitly request this level, use depth 1 or depth 2.',
      ].join('\n');
  }
}

/**
 * The quick-mode intro, rendered only when quick mode is enabled. The first
 * paragraph (what depth 0 is) is constant; the second names the ordinary
 * choice, relative to the effective default.
 */
function quickDoc(effectiveDefault: number): string {
  const first =
    '**Depth 0 (quick) is available on this host.** Use `depth: 0` for a single verifiable fact, a URL, a price, a version number, or a yes/no with a source — or when the user says "just check", "one-liner", or "don\'t overdo it". It runs one search-and-read pass with no researcher team and answers concisely.';
  let second: string;
  switch (effectiveDefault) {
    case 0:
      second = '`depth: 0` is the ordinary choice; `depth: 1` is the escalation for coordinated research, `depth: 2` for complex or multi-faceted topics, `depth: 3` only on explicit request.';
      break;
    case 2:
      second = '`depth: 2` is the ordinary choice (your configured default); `depth: 1` for simple lookups, `depth: 3` only on explicit request.';
      break;
    case 3:
      second = '`depth: 3` is the ordinary choice (your configured default); `depth: 1` for simple lookups, `depth: 2` for complex topics.';
      break;
    case 1:
    default:
      second = '`depth: 1` remains the normal choice. `depth: 2` is the escalation for complex or multi-faceted questions; `depth: 3` only on explicit request.';
      break;
  }
  return first + '\n\n' + second;
}
