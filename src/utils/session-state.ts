/**
 * Research Session State Management
 *
 * Tracks failures and state across the entire research session
 * (not just per delegate_research call).
 *
 * This enables robust failure tracking:
 * - Cumulative failures across multiple delegation rounds
 * - Unique researcher counting (same researcher failing N times = 1 failure)
 * - Proper cleanup to prevent memory leaks
 */

/**
 * Current research session ID
 * Null when no research session is active
 */
let currentResearchSessionId: string | null = null;

/**
 * Map of session ID → array of failed researcher sliceKeys
 * Tracks which specific researchers failed (by sliceKey)
 */
const sessionFailures = new Map<string, string[]>();

/**
 * Maximum allowed unique failed researchers before stopping research
 */
const MAX_FAILED_RESEARCHERS = 2;

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `research-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Start a new research session
 *
 * Initializes session state with empty failure list.
 * Should be called at the start of research tool execution.
 */
export function startResearchSession(): string {
  const sessionId = generateSessionId();
  currentResearchSessionId = sessionId;
  sessionFailures.set(sessionId, []);
  return sessionId;
}

/**
 * End the current research session
 *
 * Cleans up session state to prevent memory leaks.
 * Should be called when research tool completes (success or error).
 */
export function endResearchSession(): void {
  if (currentResearchSessionId) {
    sessionFailures.delete(currentResearchSessionId);
    currentResearchSessionId = null;
  }
}

/**
 * Record a researcher failure
 *
 * @param sliceKey - The sliceKey of the failed researcher (e.g., "1:1", "2:3")
 */
export function recordResearcherFailure(sliceKey: string): void {
  if (currentResearchSessionId) {
    const failures = sessionFailures.get(currentResearchSessionId) || [];
    failures.push(sliceKey);
    sessionFailures.set(currentResearchSessionId, failures);
    // Log to help diagnose failure patterns
    // (only logs if verbose mode is enabled)
  }
}

/**
 * Get list of unique failed researchers in current session
 *
 * Uses Set to deduplicate - same researcher failing multiple times
 * counts as 1 failed researcher.
 *
 * @returns Array of unique sliceKeys that failed
 */
export function getFailedResearchers(): string[] {
  if (!currentResearchSessionId) return [];
  const failures = sessionFailures.get(currentResearchSessionId) || [];
  return [...new Set(failures)];
}

/**
 * Check if research should stop due to too many unique failures
 *
 * @returns True if 2+ unique researchers have failed
 */
export function shouldStopResearch(): boolean {
  return getFailedResearchers().length >= MAX_FAILED_RESEARCHERS;
}

/**
 * Get formatted error message for research stoppage
 *
 * Includes which researchers failed and suggests actions.
 *
 * @returns Detailed error message
 */
export function getResearchStopMessage(): string {
  const failed = getFailedResearchers();
  const count = failed.length;
  
  return [
    `Research stopped: ${count} researcher(s) failed: ${failed.join(', ')}.`,
    '',
    'This suggests a systemic issue (network connectivity, SearXNG unavailability, or configuration).',
    '',
    'Troubleshooting:',
    '• Check network connection',
    '• Verify SearXNG is running: `docker ps | grep searxng`',
    '• Check SearXNG logs: `docker logs searxng`',
    '• Verify environment variables (SEARXNG_URL, TOR_ENABLED, etc.)',
    '',
    'Partial results may be available below.',
  ].join('\n');
}

/**
 * Get current session ID (for debugging)
 *
 * @returns Current session ID or null
 */
export function getCurrentSessionId(): string | null {
  return currentResearchSessionId;
}

/**
 * Get all active sessions (for debugging)
 *
 * @returns Map of session IDs to their failure counts
 */
export function getAllSessions(): Map<string, number> {
  const result = new Map<string, number>();
  for (const [sessionId, failures] of sessionFailures.entries()) {
    const uniqueFailures = new Set(failures).size;
    result.set(sessionId, uniqueFailures);
  }
  return result;
}
