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
 * Upper bound on the forward candidate scan in extractJsonObject/extractJsonArray.
 * Prose braces ("Fill {placeholder} …") or citation brackets ("[see note] …") can
 * precede the real payload, so a closed-but-unparseable candidate must not end the
 * search — but brace-dense non-JSON text must not turn extraction into a quadratic
 * walk either, hence the cap.
 */
const MAX_JSON_CANDIDATES = 8;

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
 * Walks forward with depth-tracking (respecting string literals) from each `{`
 * candidate to its matching `}`. A candidate that closes but fails to parse is a
 * prose brace (e.g. "Fill {placeholder} like this: {…}"), so the scan advances to
 * the next `{` — bounded by MAX_JSON_CANDIDATES. Truncated-repair applies at the
 * first UNCLOSED candidate: past that point there is no further text to scan, and
 * an unclosed opener is what genuinely cut-off LLM output looks like.
 *
 * @param text - Text to search for JSON object
 * @returns Extraction result with parsed value or error
 */
export function extractJsonObject<T = unknown>(
  text: string
): JsonExtractionResult<T> {
  let objStart = text.indexOf('{');

  if (objStart === -1) {
    return {
      success: false,
      value: undefined,
      error: 'No JSON object boundaries found',
    };
  }

  let lastParseError = 'unknown parse error';
  for (
    let attempt = 0;
    attempt < MAX_JSON_CANDIDATES && objStart !== -1;
    attempt++, objStart = text.indexOf('{', objStart + 1)
  ) {
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
      // Closed but unparseable — a prose brace, not the payload. Try the next `{`.
      lastParseError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    success: false,
    value: undefined,
    error: `Failed to parse JSON object: ${lastParseError}`,
  };
}

/**
 * Extract JSON array from raw text
 *
 * Walks forward with depth-tracking (respecting string literals) from each `[`
 * candidate to its matching `]`. A candidate that closes but fails to parse is a
 * citation-style bracket (e.g. "[see note] … [\"a\",\"b\"]"), so the scan advances
 * to the next `[` — bounded by MAX_JSON_CANDIDATES. Truncated-repair applies at
 * the first UNCLOSED candidate: past that point there is no further text to scan,
 * and an unclosed opener is what genuinely cut-off LLM output looks like.
 *
 * @param text - Text to search for JSON array
 * @returns Extraction result with parsed value or error
 */
export function extractJsonArray<T = unknown>(
  text: string
): JsonExtractionResult<T[]> {
  let arrStart = text.indexOf('[');

  if (arrStart === -1) {
    return {
      success: false,
      value: undefined,
      error: 'No JSON array boundaries found',
    };
  }

  let lastError = 'unknown parse error';
  let lastErrorShape: 'not-array' | 'parse' = 'parse';
  for (
    let attempt = 0;
    attempt < MAX_JSON_CANDIDATES && arrStart !== -1;
    attempt++, arrStart = text.indexOf('[', arrStart + 1)
  ) {
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
        lastErrorShape = 'not-array';
        continue;
      }
      return { success: true, value: parsed as T[], method: 'raw-array' };
    } catch (err) {
      // Closed but unparseable — a citation bracket, not the payload. Try the next `[`.
      lastErrorShape = 'parse';
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (lastErrorShape === 'not-array') {
    return {
      success: false,
      value: undefined,
      error: 'Parsed value is not an array',
    };
  }
  return {
    success: false,
    value: undefined,
    error: `Failed to parse JSON array: ${lastError}`,
  };
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
