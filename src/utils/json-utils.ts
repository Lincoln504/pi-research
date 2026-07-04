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
 * Walk forward from `start` tracking brace depth, respecting JSON string literals.
 * Returns the index of the matching closing `}`, or -1 if not found.
 * Also returns whether the walk ended while inside a string literal.
 */
function findMatchingBracket(text: string, start: number): { index: number; inString: boolean } {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { index: i, inString: false };
    }
  }
  return { index: -1, inString };
}

/**
 * Deterministically repair common JSON formation errors:
 * 1. Replace smart quotes (“, ”, ‘, ’) with standard quotes.
 * 2. Remove trailing commas before closing braces/brackets.
 */
function preRepairJson(jsonStr: string): string {
  return jsonStr
    // 1. Replace smart quotes
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    // 2. Remove trailing commas (only if they are followed by } or ] while NOT in a string)
    // This is a bit tricky with regex but works for most common cases
    .replace(/,\s*([}\]])/g, '$1');
}

/**
 * Parse a JSON slice, trying it verbatim first and only running preRepairJson on
 * failure. preRepairJson rewrites smart quotes and trailing commas even inside
 * string values, so applying it unconditionally would corrupt otherwise-valid JSON
 * whose content legitimately contains curly quotes (common when a summary quotes
 * web text). Raw-first keeps the happy path lossless; repair is the fallback.
 */
function parseRawThenRepair(jsonStr: string): unknown {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return JSON.parse(preRepairJson(jsonStr));
  }
}

/**
 * Extract JSON object from raw text
 *
 * Finds the first `{` then walks forward with depth-tracking (respecting string
 * literals) to locate its matching `}`. This correctly handles text that contains
 * multiple JSON objects or has trailing content after the object.
 *
 * @param text - Text to search for JSON object
 * @returns Extraction result with parsed value or error
 */
export function extractJsonObject<T = unknown>(
  text: string
): JsonExtractionResult<T> {
  const objStart = text.indexOf('{');

  if (objStart === -1) {
    return {
      success: false,
      value: undefined,
      error: 'No JSON object boundaries found',
    };
  }

  const { index: objEnd, inString } = findMatchingBracket(text, objStart);

  if (objEnd === -1) {
    // Attempt local repair for truncated JSON
    logger.debug('[json-utils] JSON object truncated; attempting local repair');
    let partialText = text.slice(objStart);
    
    // If we were inside a string, we MUST close it first
    if (inString) {
        partialText += '"';
    }

    for (let i = 1; i <= 15; i++) {
      try {
        const candidate = preRepairJson(partialText + '}'.repeat(i));
        const parsed = JSON.parse(candidate);
        logger.debug(`[json-utils] JSON object truncated; salvaged by appending ${inString ? 'quote and ' : ''}${i} closing braces`);
        return { success: true, value: parsed as T, method: 'raw-object' };
      } catch {
        continue;
      }
    }
    
    return {
      success: false,
      value: undefined,
      error: 'No matching closing brace found and local repair failed',
    };
  }

  try {
    const parsed = parseRawThenRepair(text.slice(objStart, objEnd + 1));
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
  const arrStart = text.indexOf('[');

  if (arrStart === -1) {
    return {
      success: false,
      value: undefined,
      error: 'No JSON array boundaries found',
    };
  }

  const { index: arrEnd, inString } = findMatchingBracket(text, arrStart);
  if (arrEnd === -1) {
    // Attempt local repair for truncated JSON
    logger.debug('[json-utils] JSON array truncated; attempting local repair');
    let partialText = text.slice(arrStart);
    
    if (inString) {
        partialText += '"';
    }

    for (let i = 1; i <= 15; i++) {
      try {
        const candidate = preRepairJson(partialText + ']'.repeat(i));
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
          logger.debug(`[json-utils] JSON array truncated; salvaged by appending ${inString ? 'quote and ' : ''}${i} closing brackets`);
          return { success: true, value: parsed as T[], method: 'raw-array' };
        }
      } catch {
        continue;
      }
    }

    return {
      success: false,
      value: undefined,
      error: 'No matching closing bracket found and local repair failed',
    };
  }

  try {
    const parsed = parseRawThenRepair(text.slice(arrStart, arrEnd + 1));
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
 * 1. Direct parse of the whole trimmed string (the payload IS the JSON)
 * 2. Code blocks
 * 3. Raw JSON object (for objects)
 * 4. Raw JSON array (for arrays)
 *
 * @param text - Text to extract JSON from
 * @param targetType - Whether to expect 'object', 'array', or 'any'
 * @returns Extraction result with parsed value or error
 */
export function extractJson<T = unknown>(
  text: string,
  targetType: 'object' | 'array' | 'any' = 'any'
): JsonExtractionResult<T> {
  // Direct parse first: when the entire response is the JSON payload, a fenced
  // ```json example embedded INSIDE one of its string values must not win —
  // code-block-first extraction would latch onto that example and return it
  // instead of the real payload.
  try {
    const direct = JSON.parse(text.trim());
    const isArray = Array.isArray(direct);
    const typeMatches =
      targetType === 'any' ||
      (targetType === 'array' ? isArray : !isArray && direct !== null && typeof direct === 'object');
    if (typeMatches && direct !== null && typeof direct === 'object') {
      logger.debug('[json-utils] Extracted JSON via direct parse of full text');
      return { success: true, value: direct as T, method: isArray ? 'raw-array' : 'raw-object' };
    }
  } catch {
    // Not a pure-JSON payload — fall through to the extraction chain.
  }

  // Try code blocks next (most reliable for mixed prose+JSON responses)
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
