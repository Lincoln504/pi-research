/**
 * Date Injection Utility
 *
 * Injects the current date into agent prompts.
 */

/**
 * Format the current month + year (e.g. "June 2026") — the temporal anchor
 * that must lead the prompt so queries are not defaulted to stale years.
 */
function getCurrentMonthYearString(): string {
  const now = new Date();
  return now.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

/**
 * Format current date as a full readable string (e.g. "Monday, June 29, 2026").
 */
function getCurrentDateString(): string {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  return now.toLocaleDateString('en-US', options);
}

/**
 * Inject current date into a prompt.
 *
 * Prepends a strongly-worded temporal anchor that leads with the current MONTH
 * and YEAR (the values most likely to be wrong if the model falls back to
 * training-cutoff defaults). The full date follows for precision. Applies to
 * coordinator, researcher, and evaluator across all modes.
 */
export function injectCurrentDate(prompt: string, _agentType: 'coordinator' | 'researcher' | 'evaluator'): string {
  const monthYear = getCurrentMonthYearString();
  const fullDate = getCurrentDateString();
  const dateContext =
    `**CURRENT MONTH AND YEAR: ${monthYear}** (today is ${fullDate})\n\n` +
    `You are operating in ${monthYear}. All queries, analysis, and "latest"/"current"/"recent" ` +
    `framing MUST be anchored to ${monthYear}. When a query is time-sensitive, use the current ` +
    `month and year (${monthYear}) explicitly — do NOT default to an earlier year such as 2024 or ` +
    `2025 unless the user is explicitly asking about the past.\n\n`;
  return dateContext + prompt;
}
