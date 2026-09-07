/**
 * Neutralize external URLs in tool output so terminal-UI markdown renderers
 * cannot turn them into clickable hyperlinks.
 *
 * Why this exists: pi's TUI (and most markdown-rendering terminals) convert
 * markdown links AND bare URLs (GFM autolink) into OSC 8 terminal hyperlinks,
 * and a mouse press+release on such a span opens the URL in the user's real
 * browser. Tool results are agent-facing data, not interactive UI — a URL
 * appearing there should never be one accidental click away from opening a
 * tab, and third-party content (question bodies, API fields) must not be able
 * to inject clickable links into the user's terminal at all.
 *
 * Mechanism: wrapping a URL in backticks makes it a markdown code span. Code
 * spans are tokenized before autolink in every CommonMark/GFM tokenizer
 * (verified against the `marked` version pi ships), so the URL renders as
 * literal text — copyable by humans, trivially extractable by the model, and
 * impossible to click.
 */

/** Longest run of backticks that can safely fence arbitrary content. */
const MIN_FENCE = 3;

/**
 * Return `url` as a markdown code span: renders as plain text everywhere,
 * never becomes a clickable hyperlink, and stays byte-exact for the model.
 */
export function plainUrl(url: string): string {
  const safe = url.replace(/`/g, '%60');
  return `\`${safe}\``;
}

/**
 * Wrap arbitrary third-party text (question bodies, API-provided markup) in a
 * fenced code block so no markdown inside it — links, headings, tables — is
 * ever rendered or autolinked. The fence length grows past any backtick run
 * found in the content, so content containing ``` fences cannot close it
 * early.
 */
export function fenceBlock(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(MIN_FENCE, longest + 1));
  return `${fence}text\n${content}\n${fence}`;
}
