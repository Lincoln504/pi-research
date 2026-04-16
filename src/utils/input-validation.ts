/**
 * Input Validation Utilities
 *
 * Basic validation for research queries and parameters.
 */

import { logger } from '../logger.ts';

/** Maximum query length */
export const MAX_QUERY_LENGTH = 500;

/** Minimum query length */
export const MIN_QUERY_LENGTH = 3;

/**
 * Validate research query
 *
 * @param query - The research query to validate
 * @returns Object with isValid flag and optional error message
 */
export function validateQuery(query: string): { isValid: boolean; error?: string } {
  // Check if query is provided
  if (!query || typeof query !== 'string') {
    return { isValid: false, error: 'Query must be a non-empty string' };
  }

  const trimmed = query.trim();

  // Check minimum length
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return { isValid: false, error: `Query must be at least ${MIN_QUERY_LENGTH} characters` };
  }

  // Check maximum length
  if (trimmed.length > MAX_QUERY_LENGTH) {
    return { isValid: false, error: `Query must be at most ${MAX_QUERY_LENGTH} characters` };
  }

  // Check for empty or whitespace-only queries
  if (trimmed === '') {
    return { isValid: false, error: 'Query cannot be empty or whitespace-only' };
  }

  // Check for potentially dangerous patterns
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i, // Event handlers like onclick=
    /<iframe/i,
    /<object/i,
    /<embed/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmed)) {
      return { isValid: false, error: 'Query contains potentially dangerous content' };
    }
  }

  return { isValid: true };
}

/**
 * Sanitize research query for safe use
 *
 * @param query - The research query to sanitize
 * @returns Sanitized query
 */
export function sanitizeQuery(query: string): string {
  return query
    .trim()
    .replace(/\s+/g, ' ') // Normalize whitespace
    .replace(/[\x00-\x1F\x7F]/g, ''); // eslint-disable-line no-control-regex -- Remove control characters
}

/**
 * Validate and sanitize research query in one step
 *
 * @param query - The research query to validate and sanitize
 * @returns Sanitized query or throws error if invalid
 * @throws Error if query is invalid
 */
export function validateAndSanitizeQuery(query: string): string {
  const validation = validateQuery(query);

  if (!validation.isValid) {
    const error = validation.error || 'Invalid query';
    logger.warn(`[input-validation] ${error}`);
    throw new Error(error);
  }

  return sanitizeQuery(query);
}

/**
 * Validate complexity level
 *
 * @param complexity - The complexity level to validate
 * @returns True if valid, false otherwise
 */
export function validateComplexity(complexity: number): boolean {
  return complexity === 1 || complexity === 2 || complexity === 3 || complexity === 4;
}
