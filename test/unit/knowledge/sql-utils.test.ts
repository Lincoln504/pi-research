/**
 * Tests for the knowledge store's SQL string-literal helper (sql-utils.ts).
 *
 * The helper is the injection boundary for every DataFusion query the store
 * builds by interpolation: its inputs are attacker-influenced (stored URLs,
 * workspace paths, ingestion types), so the escaping rule is pinned here.
 */

import { describe, it, expect } from 'vitest';
import { sqlString } from '../../../src/knowledge/sql-utils.ts';

describe('sqlString', () => {
  it('wraps a plain value in single quotes', () => {
    expect(sqlString('https://example.com/a')).toBe("'https://example.com/a'");
  });

  it('escapes embedded single quotes by doubling (DataFusion standard SQL)', () => {
    expect(sqlString("it's")).toBe("'it''s'");
    expect(sqlString("a'b'c")).toBe("'a''b''c'");
    expect(sqlString("''")).toBe("''''''");
  });

  it('does not apply any other escaping (no backslash, backtick or newline rule)', () => {
    // DataFusion string literals have no backslash escape; the doubled-quote
    // rule is the complete rule, so these must pass through untouched.
    expect(sqlString('a\\b')).toBe("'a\\b'");
    expect(sqlString('a\nb')).toBe("'a\nb'");
    expect(sqlString('a`b')).toBe("'a`b'");
  });

  it('handles an empty string', () => {
    expect(sqlString('')).toBe("''");
  });
});
