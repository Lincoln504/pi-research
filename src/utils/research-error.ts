/**
 * Research Error Handling
 *
 * Custom error class and error codes for research operations.
 */

import { logger } from '../logger.ts';

/**
 * Research error codes
 */
export enum ResearchErrorCode {
  // General errors
  UNKNOWN = 'UNKNOWN',
  INVALID_INPUT = 'INVALID_INPUT',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',

  // Configuration errors
  CONFIG_INVALID = 'CONFIG_INVALID',
  CONFIG_MISSING = 'CONFIG_MISSING',

  // Network/API errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  API_ERROR = 'API_ERROR',
  API_RATE_LIMITED = 'API_RATE_LIMITED',
  API_TIMEOUT = 'API_TIMEOUT',
  API_UNAVAILABLE = 'API_UNAVAILABLE',

  // Browser/Search errors
  BROWSER_LAUNCH_FAILED = 'BROWSER_LAUNCH_FAILED',
  BROWSER_CRASHED = 'BROWSER_CRASHED',
  SEARCH_FAILED = 'SEARCH_FAILED',
  SEARCH_TIMEOUT = 'SEARCH_TIMEOUT',
  IP_BLOCKED = 'IP_BLOCKED',

  // Orchestrator errors
  ORCHESTRATION_FAILED = 'ORCHESTRATION_FAILED',
  PLANNING_FAILED = 'PLANNING_FAILED',
  RESEARCH_FAILED = 'RESEARCH_FAILED',
  SYNTHESIS_FAILED = 'SYNTHESIS_FAILED',

  // Researcher errors
  RESEARCHER_FAILED = 'RESEARCHER_FAILED',
  RESEARCHER_TIMEOUT = 'RESEARCHER_TIMEOUT',

  // Scraping errors
  SCRAPE_FAILED = 'SCRAPE_FAILED',
  SCRAPE_TIMEOUT = 'SCRAPE_TIMEOUT',
  SCRAPE_RATE_LIMITED = 'SCRAPE_RATE_LIMITED',

  // Export errors
  EXPORT_FAILED = 'EXPORT_FAILED',

  // Validation errors
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  QUERY_TOO_SHORT = 'QUERY_TOO_SHORT',
  QUERY_TOO_LONG = 'QUERY_TOO_LONG',
  QUERY_INVALID = 'QUERY_INVALID',

  // State errors
  STATE_INVALID = 'STATE_INVALID',
  STATE_TRANSITION_FAILED = 'STATE_TRANSITION_FAILED',
}

/**
 * Research error class
 *
 * Provides structured error information for research operations.
 */
export class ResearchError extends Error {
  public readonly code: ResearchErrorCode;
  public readonly details?: unknown;
  public readonly correlationId: string;
  public readonly timestamp: number;

  constructor(
    code: ResearchErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ResearchError';
    this.code = code;
    this.details = details;
    this.correlationId = generateCorrelationId();
    this.timestamp = Date.now();

    // Ensure proper prototype chain
    Object.setPrototypeOf(this, ResearchError.prototype);
  }

  /**
   * Convert error to a serializable object
   */
  toJSON(): {
    name: string;
    code: ResearchErrorCode;
    message: string;
    details?: unknown;
    correlationId: string;
    timestamp: number;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      correlationId: this.correlationId,
      timestamp: this.timestamp,
    };
  }

  /**
   * Log the error with correlation ID
   */
  log(context?: string): void {
    const prefix = context ? `[${context}] ` : '';
    logger.error(`${prefix}ResearchError: ${this.code}`, {
      message: this.message,
      details: this.details,
      correlationId: this.correlationId,
      timestamp: this.timestamp,
    });
  }
}

/**
 * Generate a correlation ID for error tracking
 */
function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Create a ResearchError from an unknown error
 *
 * @param error - The error to convert
 * @param defaultCode - Default error code if type cannot be determined
 * @returns A ResearchError instance
 */
export function createResearchError(
  error: unknown,
  defaultCode: ResearchErrorCode = ResearchErrorCode.UNKNOWN,
): ResearchError {
  if (error instanceof ResearchError) {
    return error;
  }

  if (error instanceof Error) {
    // Try to determine error code from error message
    const message = error.message.toLowerCase();

    if (message.includes('timeout')) {
      return new ResearchError(ResearchErrorCode.API_TIMEOUT, error.message, error);
    }

    if (message.includes('rate limit') || message.includes('too many requests')) {
      return new ResearchError(ResearchErrorCode.API_RATE_LIMITED, error.message, error);
    }

    if (message.includes('network') || message.includes('econnrefused')) {
      return new ResearchError(ResearchErrorCode.NETWORK_ERROR, error.message, error);
    }

    if (message.includes('404') || message.includes('not found')) {
      return new ResearchError(ResearchErrorCode.API_UNAVAILABLE, error.message, error);
    }

    // Generic error
    return new ResearchError(defaultCode, error.message, error);
  }

  // Unknown error type
  return new ResearchError(
    defaultCode,
    typeof error === 'string' ? error : 'Unknown error',
    error,
  );
}

/**
 * Check if an error is transient (can be retried)
 *
 * @param error - The error to check
 * @returns True if the error is transient
 */
export function isTransientError(error: ResearchError): boolean {
  const transientCodes = [
    ResearchErrorCode.NETWORK_ERROR,
    ResearchErrorCode.API_RATE_LIMITED,
    ResearchErrorCode.API_TIMEOUT,
    ResearchErrorCode.API_UNAVAILABLE,
    ResearchErrorCode.BROWSER_LAUNCH_FAILED,
    ResearchErrorCode.SEARCH_TIMEOUT,
    ResearchErrorCode.IP_BLOCKED,
  ];

  return transientCodes.includes(error.code);
}

/**
 * Check if an error is fatal (cannot be retried)
 *
 * @param error - The error to check
 * @returns True if the error is fatal
 */
export function isFatalError(error: ResearchError): boolean {
  return !isTransientError(error);
}
