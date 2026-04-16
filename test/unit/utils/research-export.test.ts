/**
 * Research Export Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportResearchReport, appendExportMessage } from '../../../src/utils/research-export.ts';

// Mock at top level
vi.mock('node:fs', async () => ({
  promises: {
    writeFile: vi.fn(),
  },
}));

describe('exportResearchReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const getMockWriteFile = async () => {
    const fs = await import('node:fs');
    return vi.mocked(fs.promises.writeFile);
  };

  it('should sanitize query for filename', async () => {
    const mockWriteFile = await getMockWriteFile();
    mockWriteFile.mockResolvedValue(undefined);

    await exportResearchReport('Test Query with Spaces!', 'result', 'quick');

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('pi-research-test-query-with-spaces-'),
      'result',
      { flag: 'wx' }
    );
  });

  it('should truncate long queries', async () => {
    const mockWriteFile = await getMockWriteFile();
    mockWriteFile.mockResolvedValue(undefined);

    const longQuery = 'a'.repeat(100);
    await exportResearchReport(longQuery, 'result', 'quick');

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(/pi-research-[^\/]+-[a-z0-9]{2}\.md/),
      'result',
      { flag: 'wx' }
    );
  });

  it('should handle special characters', async () => {
    const mockWriteFile = await getMockWriteFile();
    mockWriteFile.mockResolvedValue(undefined);

    await exportResearchReport('Test @#$%^&*()_+ Query', 'result', 'deep');

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('pi-research-test-query-'),
      'result',
      { flag: 'wx' }
    );
  });

  it('should retry on hash collision', async () => {
    const mockWriteFile = await getMockWriteFile();
    const eexistError = new Error('File exists') as NodeJS.ErrnoException;
    eexistError.code = 'EEXIST';
    mockWriteFile
      .mockRejectedValueOnce(eexistError)
      .mockRejectedValueOnce(eexistError)
      .mockResolvedValue(undefined);

    const result = await exportResearchReport('test', 'content', 'quick');

    expect(result).not.toBeNull();
    expect(mockWriteFile).toHaveBeenCalledTimes(3);
  });

  it('should return null on other errors', async () => {
    const mockWriteFile = await getMockWriteFile();
    mockWriteFile.mockRejectedValue(new Error('Permission denied'));

    const result = await exportResearchReport('test', 'content', 'quick');

    expect(result).toBeNull();
  });

  it('should return null after max retries', async () => {
    const mockWriteFile = await getMockWriteFile();
    const eexistError = new Error('File exists') as NodeJS.ErrnoException;
    eexistError.code = 'EEXIST';
    mockWriteFile.mockRejectedValue(eexistError);

    const result = await exportResearchReport('test', 'content', 'quick');

    expect(result).toBeNull();
    expect(mockWriteFile).toHaveBeenCalledTimes(3);
  });

  it('should use 2-character hash', async () => {
    const mockWriteFile = await getMockWriteFile();
    mockWriteFile.mockResolvedValue(undefined);

    await exportResearchReport('test', 'content', 'quick');

    const callArgs = mockWriteFile.mock.calls[0]?.[0] as string;
    expect(callArgs).toMatch(/-([a-z0-9]{2})\.md$/);
  });
});

describe('appendExportMessage', () => {
  it('should append export message to result', () => {
    const result = 'Research content';
    const filepath = '/tmp/pi-research-test-ab.md';

    const final = appendExportMessage(result, filepath);

    expect(final).toBe(`${result}\n\n---\n\nResearch report saved to: ${filepath}`);
  });

  it('should handle empty result', () => {
    const result = '';
    const filepath = '/tmp/pi-research-test-ab.md';

    const final = appendExportMessage(result, filepath);

    expect(final).toContain('Research report saved to: /tmp/pi-research-test-ab.md');
  });

  it('should handle multi-line result', () => {
    const result = 'Line 1\nLine 2\nLine 3';
    const filepath = '/tmp/pi-research-test-ab.md';

    const final = appendExportMessage(result, filepath);

    expect(final).toBe(`${result}\n\n---\n\nResearch report saved to: ${filepath}`);
  });
});
