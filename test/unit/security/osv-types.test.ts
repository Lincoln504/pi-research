import { describe, it, expect } from 'vitest';
import { mapOsvItemToVulnerability, type OsvVulnerability } from '../../../src/security/osv-types.ts';

describe('mapOsvItemToVulnerability', () => {
  it('does not throw on a null entry in database_specific.cwe (malformed, source-defined JSON)', () => {
    const item = {
      id: 'GHSA-test-0000',
      summary: 'Test advisory',
      database_specific: {
        cwe: [null, 'CWE-79', { id: 'CWE-89' }],
      },
    } as unknown as OsvVulnerability;

    const result = mapOsvItemToVulnerability(item);
    expect(result.cwes).toEqual(['CWE-79', 'CWE-89']);
  });

  it('still maps well-formed string and object cwe entries', () => {
    const item = {
      id: 'GHSA-test-0001',
      database_specific: {
        cwe: ['CWE-79', { id: 'CWE-89' }],
      },
    } as unknown as OsvVulnerability;

    const result = mapOsvItemToVulnerability(item);
    expect(result.cwes).toEqual(['CWE-79', 'CWE-89']);
  });
});
