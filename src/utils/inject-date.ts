/**
 * Date Injection Utility
 *
 * Injects the current date into agent prompts.
 */

/**
 * Format current date as a readable string
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
 * Inject current date into a prompt
 * Prepends a date context line to the prompt
 */
export function injectCurrentDate(prompt: string, _agentType: 'coordinator' | 'researcher' | 'evaluator'): string {
  const dateString = getCurrentDateString();
  const dateContext = `**Current Date:** ${dateString}\n\n`;
  return dateContext + prompt;
}
