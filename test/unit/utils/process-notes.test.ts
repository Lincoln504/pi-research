/**
 * Report Extraction Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { extractProcessNotes } from '../../../src/utils/process-notes';

describe('extractProcessNotes', () => {
  it('extracts notes when present', () => {
    const reports = [
      {
        id: '1.1',
        query: 'test query',
        report: `### Research Process Notes
- Tool failed to load PDF
- Search returned irrelevant results

### Findings
Some findings...`
      }
    ];
    const result = extractProcessNotes(reports);
    expect(result).toContain('Research Process Notes (Aggregated)');
    expect(result).toContain('Researcher 1.1: test query');
    expect(result).toContain('Tool failed to load PDF');
    expect(result).toContain('Search returned irrelevant results');
  });

  it('returns empty string when no notes', () => {
    const reports = [
      { id: '1.1', query: 'test', report: '### Findings\n...' }
    ];
    const result = extractProcessNotes(reports);
    expect(result).toBe('');
  });

  it('filters empty notes', () => {
    const reports = [
      { id: '1.1', query: 'test', report: '### Research Process Notes\n   \n\n### Findings' }
    ];
    const result = extractProcessNotes(reports);
    expect(result).toBe('');
  });

  it('handles multiple researchers', () => {
    const reports = [
      { id: '1.1', query: 'q1', report: '### Research Process Notes\n- Note 1\n\n### Findings' },
      { id: '1.2', query: 'q2', report: '### Research Process Notes\n- Note 2\n\n### Findings' }
    ];
    const result = extractProcessNotes(reports);
    expect(result).toContain('Researcher 1.1: q1');
    expect(result).toContain('Researcher 1.2: q2');
    expect(result).toContain('Note 1');
    expect(result).toContain('Note 2');
  });

  it('handles case-insensitive section header', () => {
    const reports = [
      {
        id: '1.1',
        query: 'test',
        report: `### research process notes
- Tool failed

### Findings`
      }
    ];
    const result = extractProcessNotes(reports);
    expect(result).toContain('Research Process Notes (Aggregated)');
    expect(result).toContain('Tool failed');
  });

  it('allows ### or #### for section header', () => {
    const reports = [
      {
        id: '1.1',
        query: 'test',
        report: `#### Research Process Notes
- Tool failed

### Findings`
      }
    ];
    const result = extractProcessNotes(reports);
    expect(result).toContain('Research Process Notes (Aggregated)');
    expect(result).toContain('Tool failed');
  });

  it('ignores reports without report field', () => {
    const reports = [
      { id: '1.1', query: 'test' } as any
    ];
    const result = extractProcessNotes(reports);
    expect(result).toBe('');
  });

  it('handles empty report string', () => {
    const reports = [
      { id: '1.1', query: 'test', report: '' }
    ];
    const result = extractProcessNotes(reports);
    expect(result).toBe('');
  });

  it('stops at next section', () => {
    const reports = [
      {
        id: '1.1',
        query: 'test',
        report: `### Research Process Notes
- Note 1
### Findings
Some findings`
      }
    ];
    const result = extractProcessNotes(reports);
    expect(result).toContain('Research Process Notes (Aggregated)');
    expect(result).toContain('Note 1');
    expect(result).not.toContain('Findings');
    expect(result).not.toContain('Some findings');
  });
});
