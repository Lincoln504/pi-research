/**
 * Research Error Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ResearchErrorCode,
  ResearchError,
  createResearchError,
  isTransientError,
  isFatalError,
} from '../../../src/utils/research-error';

describe('ResearchError', () => {
  it('should create error with code and message', () => {
    const error = new ResearchError(
      ResearchErrorCode.API_ERROR,
      'API request failed',
    );

    expect(error).toBeInstanceOf(ResearchError);
    expect(error.name).toBe('ResearchError');
    expect(error.code).toBe(ResearchErrorCode.API_ERROR);
    expect(error.message).toBe('API request failed');
    expect(error.correlationId).toBeDefined();
    expect(error.timestamp).toBeDefined();
  });

  it('should create error with details', () => {
    const details = { statusCode: 500, url: 'https://example.com' };
    const error = new ResearchError(
      ResearchErrorCode.API_ERROR,
      'API request failed',
      details,
    );

    expect(error.details).toBe(details);
  });

  it('should have unique correlation IDs', () => {
    const error1 = new ResearchError(ResearchErrorCode.API_ERROR, 'Error 1');
    const error2 = new ResearchError(ResearchErrorCode.API_ERROR, 'Error 2');

    expect(error1.correlationId).not.toBe(error2.correlationId);
  });

  it('should convert to JSON', () => {
    const details = { statusCode: 500 };
    const error = new ResearchError(
      ResearchErrorCode.API_ERROR,
      'API request failed',
      details,
    );

    const json = error.toJSON();

    expect(json).toEqual({
      name: 'ResearchError',
      code: ResearchErrorCode.API_ERROR,
      message: 'API request failed',
      details,
      correlationId: error.correlationId,
      timestamp: error.timestamp,
    });
  });
});

describe('createResearchError', () => {
  it('should return ResearchError as-is', () => {
    const original = new ResearchError(ResearchErrorCode.API_ERROR, 'Test error');
    const result = createResearchError(original);

    expect(result).toBe(original);
  });

  it('should convert Error to ResearchError', () => {
    const original = new Error('Network connection failed');
    const result = createResearchError(original);

    expect(result).toBeInstanceOf(ResearchError);
    expect(result.code).toBe(ResearchErrorCode.NETWORK_ERROR);
    expect(result.message).toBe('Network connection failed');
    expect(result.details).toBe(original);
  });

  it('should detect timeout errors', () => {
    const original = new Error('Request timeout after 30s');
    const result = createResearchError(original);

    expect(result.code).toBe(ResearchErrorCode.API_TIMEOUT);
  });

  it('should detect rate limit errors', () => {
    const original = new Error('Model API rate limit (429)');
    const result = createResearchError(original);

    expect(result.code).toBe(ResearchErrorCode.API_RATE_LIMITED);
  });

  it('should detect network errors', () => {
    const original = new Error('fetch failed due to network error');
    const result = createResearchError(original);

    expect(result.code).toBe(ResearchErrorCode.NETWORK_ERROR);
  });

  it('should use default code for unknown errors', () => {
    const original = new Error('Unknown error occurred');
    const result = createResearchError(original, ResearchErrorCode.UNKNOWN);

    expect(result.code).toBe(ResearchErrorCode.UNKNOWN);
  });

  it('should convert string errors', () => {
    const result = createResearchError('String error');

    expect(result).toBeInstanceOf(ResearchError);
    expect(result.message).toBe('String error');
  });

  it('should convert unknown types', () => {
    const result = createResearchError(12345);

    expect(result).toBeInstanceOf(ResearchError);
    expect(result.message).toBe('Unknown error');
  });
});

describe('isTransientError', () => {
  it('should identify network errors as transient', () => {
    const error = new ResearchError(ResearchErrorCode.NETWORK_ERROR, 'Network error');
    expect(isTransientError(error)).toBe(true);
  });

  it('should identify rate limit errors as transient', () => {
    const error = new ResearchError(ResearchErrorCode.API_RATE_LIMITED, 'Rate limited');
    expect(isTransientError(error)).toBe(true);
  });

  it('should identify timeout errors as transient', () => {
    const error = new ResearchError(ResearchErrorCode.API_TIMEOUT, 'Timeout');
    expect(isTransientError(error)).toBe(true);
  });

  it('should identify unavailable errors as transient', () => {
    const error = new ResearchError(ResearchErrorCode.API_UNAVAILABLE, 'Unavailable');
    expect(isTransientError(error)).toBe(true);
  });

  it('should identify browser launch failures as transient', () => {
    const error = new ResearchError(ResearchErrorCode.BROWSER_LAUNCH_FAILED, 'Launch failed');
    expect(isTransientError(error)).toBe(true);
  });

  it('should identify IP blocks as transient', () => {
    const error = new ResearchError(ResearchErrorCode.IP_BLOCKED, 'IP blocked');
    expect(isTransientError(error)).toBe(true);
  });

  it('should not identify invalid input as transient', () => {
    const error = new ResearchError(ResearchErrorCode.INVALID_INPUT, 'Invalid input');
    expect(isTransientError(error)).toBe(false);
  });

  it('should not identify validation failures as transient', () => {
    const error = new ResearchError(ResearchErrorCode.VALIDATION_FAILED, 'Validation failed');
    expect(isTransientError(error)).toBe(false);
  });

  it('should not identify config errors as transient', () => {
    const error = new ResearchError(ResearchErrorCode.CONFIG_INVALID, 'Config invalid');
    expect(isTransientError(error)).toBe(false);
  });
});

describe('isFatalError', () => {
  it('should identify transient errors as not fatal', () => {
    const error = new ResearchError(ResearchErrorCode.NETWORK_ERROR, 'Network error');
    expect(isFatalError(error)).toBe(false);
  });

  it('should identify non-transient errors as fatal', () => {
    const error = new ResearchError(ResearchErrorCode.INVALID_INPUT, 'Invalid input');
    expect(isFatalError(error)).toBe(true);
  });
});

describe('ResearchError - robustness', () => {
  it('should maintain prototype chain for instanceof checks', () => {
    const error = new ResearchError(ResearchErrorCode.UNKNOWN, 'test');
    expect(error instanceof ResearchError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it('should capture stack traces correctly', () => {
    const error = new ResearchError(ResearchErrorCode.UNKNOWN, 'test');
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('research-error.test.ts');
  });

  it('should handle undefined details in toJSON', () => {
    const error = new ResearchError(ResearchErrorCode.UNKNOWN, 'test');
    const json = error.toJSON();
    expect(json.details).toBeUndefined();
    expect(json).toHaveProperty('correlationId');
  });

  it('should generate distinct correlation IDs for rapid errors', () => {
    const e1 = new ResearchError(ResearchErrorCode.UNKNOWN, '1');
    const e2 = new ResearchError(ResearchErrorCode.UNKNOWN, '2');
    expect(e1.correlationId).not.toBe(e2.correlationId);
  });
});
