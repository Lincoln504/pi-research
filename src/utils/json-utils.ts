/**
 * JSON Parsing Utilities
 *
 * Shared utilities for parsing JSON from LLM responses.
 * Handles various formats including code blocks, raw JSON, and malformed input.
 */

import { logger } from '../logger.ts';

/**
 * Result of a JSON extraction attempt
 */
export interface JsonExtractionResult<T = unknown> {
  /** Whether extraction was successful */
  success: boolean;
  /** The parsed value if successful, undefined otherwise */
  value: T | undefined;
  /** Error message if unsuccessful */
  error?: string;
  /** The method that succeeded (for logging) */
  method?: 'code-block' | 'raw-object' | 'raw-array';
}

/**
 * Extract JSON from markdown code blocks
 *
 * Looks for ```json or ```javascript code blocks and parses the content.
 * Returns the first successfully parsed block.
 *
 * @param text - Text to search for JSON code blocks
 * @returns Extraction result with parsed value or error
 */
export function extractJsonFromCodeBlocks<T = unknown>(
  text: string
): JsonExtractionResult<T> {
  const codeBlockRegex = /```(?:json|javascript)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const codeContent = match[1] ?? '';
    try {
      const parsed = JSON.parse(codeContent.trim());
      return { success: true, value: parsed as T, method: 'code-block' };
    } catch {
      // Try next code block
      continue;
    }
  }

  return {
    success: false,
    value: undefined,
    error: 'No valid JSON found in code blocks',
  };
}

/**
 * Extract JSON object from raw text
 *
 * Looks for a JSON object spanning from the first `{` to the last `}`.
 * Useful when JSON is embedded in prose without code blocks.
 *
 * @param text - Text to search for JSON object
 * @returns Extraction result with parsed value or error
 */
export function extractJsonObject<T = unknown>(
  text: string
): JsonExtractionResult<T> {
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');

  if (objStart === -1 || objEnd <= objStart) {
    return {
      success: false,
      value: undefined,
      error: 'No JSON object boundaries found',
    };
  }

  try {
    const jsonStr = text.slice(objStart, objEnd + 1);
    const parsed = JSON.parse(jsonStr);
    return { success: true, value: parsed as T, method: 'raw-object' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      value: undefined,
      error: `Failed to parse JSON object: ${errorMsg}`,
    };
  }
}

/**
 * Extract JSON array from raw text
 *
 * Looks for a JSON array spanning from the first `[` to the last `]`.
 * Useful for extracting arrays of strings or objects.
 *
 * @param text - Text to search for JSON array
 * @returns Extraction result with parsed value or error
 */
export function extractJsonArray<T = unknown>(
  text: string
): JsonExtractionResult<T[]> {
  const stripped = text.trim();
  
  // Quick check if it's a JSON array
  if (!stripped.startsWith('[') || !stripped.endsWith(']')) {
    return {
      success: false,
      value: undefined,
      error: 'Text is not a JSON array',
    };
  }

  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) {
      return {
        success: false,
        value: undefined,
        error: 'Parsed value is not an array',
      };
    }
    return { success: true, value: parsed as T[], method: 'raw-array' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      value: undefined,
      error: `Failed to parse JSON array: ${errorMsg}`,
    };
  }
}

/**
 * Extract JSON with fallback chain
 *
 * Tries multiple extraction methods in order:
 * 1. Code blocks (most reliable)
 * 2. Raw JSON object (for objects)
 * 3. Raw JSON array (for arrays)
 *
 * @param text - Text to extract JSON from
 * @param targetType - Whether to expect 'object', 'array', or 'any'
 * @returns Extraction result with parsed value or error
 */
export function extractJson<T = unknown>(
  text: string,
  targetType: 'object' | 'array' | 'any' = 'any'
): JsonExtractionResult<T> {
  // Try code blocks first (most reliable)
  const codeBlockResult = extractJsonFromCodeBlocks<T>(text);
  if (codeBlockResult.success) {
    logger.debug('[json-utils] Extracted JSON from code block');
    return codeBlockResult;
  }

  // Try raw object (if expecting object or any)
  if (targetType === 'object' || targetType === 'any') {
    const objectResult = extractJsonObject<T>(text);
    if (objectResult.success) {
      logger.debug('[json-utils] Extracted JSON object from raw text');
      return objectResult;
    }
  }

  // Try raw array (if expecting array or any)
  if (targetType === 'array' || targetType === 'any') {
    const arrayResult = extractJsonArray<T>(text);
    if (arrayResult.success) {
      logger.debug('[json-utils] Extracted JSON array from raw text');
      return arrayResult as JsonExtractionResult<T>;
    }
  }

  // All methods failed
  return {
    success: false,
    value: undefined,
    error: 'No valid JSON found using any extraction method',
  };
}

/**
 * Result of string array normalization
 */
export interface NormalizeArrayResult {
  /** Normalized strings */
  strings: string[];
  /** Count of items that were skipped (empty after normalization) */
  skippedCount: number;
  /** Count of items that were objects and needed extraction */
  extractedCount: number;
  /** Warnings about any issues */
  warnings: string[];
}

/**
 * Normalize string array with detailed feedback
 *
 * Normalizes an array of values to strings with detailed feedback
 * about what was normalized and any issues.
 *
 * @param arr - Array of values to normalize
 * @returns Detailed normalization result
 */
export function normalizeStringArrayDetailed(
  arr: unknown[]
): NormalizeArrayResult {
  const strings: string[] = [];
  const warnings: string[] = [];
  let skippedCount = 0;
  let extractedCount = 0;

  arr.forEach((item, index) => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        strings.push(trimmed);
      } else {
        skippedCount++;
        warnings.push(`Item ${index}: empty string`);
      }
    } else if (item !== null && typeof item === 'object') {
      extractedCount++;
      const obj = item as Record<string, unknown>;
      const candidate = obj['query'] ?? obj['topic'] ?? obj['text'] ?? obj['task'];
      
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          strings.push(trimmed);
        } else {
          skippedCount++;
          warnings.push(`Item ${index}: object extracted empty string`);
        }
      } else {
        // No recognized key, stringify the whole object
        const stringified = JSON.stringify(item);
        if (stringified.length > 0) {
          strings.push(stringified);
          warnings.push(`Item ${index}: no recognized key, stringified object`);
        } else {
          skippedCount++;
          warnings.push(`Item ${index}: object stringified to empty`);
        }
      }
    } else {
      const stringified = String(item).trim();
      if (stringified.length > 0) {
        strings.push(stringified);
      } else {
        skippedCount++;
        warnings.push(`Item ${index}: ${typeof item} converted to empty string`);
      }
    }
  });

  return { strings, skippedCount, extractedCount, warnings };
}
