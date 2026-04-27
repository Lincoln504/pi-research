
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { search } from '../../../src/web-research/search.ts';

// Mock dependencies
vi.mock('../../../src/web-research/utils.ts', () => ({
  filterRelevantResults: vi.fn().mockImplementation((_query, results) => results)
}));

vi.mock('../../../src/web-research/browser-search.ts', () => ({
  performSearch: vi.fn()
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    debug: vi.fn()
  }
}));

import { performSearch } from '../../../src/web-research/browser-search.ts';

describe('search orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return results for a successful search', async () => {
    const mockResults = [{ 
      url: 'http://example.com', 
      title: 'Example Result', 
      content: 'This is a relevant content' 
    }];
    
    vi.mocked(performSearch).mockResolvedValue(new Map([['example query', mockResults]]));

    const result = await search(['example query']);

    expect(result).toHaveLength(1);
    expect(result[0]!.results).toEqual(mockResults);
  });

  it('should handle empty results', async () => {
    vi.mocked(performSearch).mockResolvedValue(new Map([['empty query', []]]));

    const result = await search(['empty query']);
    
    expect(result).toHaveLength(1);
    expect(result[0]!.results).toHaveLength(0);
    expect(result[0]!.error?.type).toBe('empty_results');
  });

  it('should handle errors gracefully', async () => {
    vi.mocked(performSearch).mockRejectedValue(new Error('Search failed'));

    const result = await search(['error query']);
    
    expect(result).toHaveLength(1);
    expect(result[0]!.error?.type).toBe('unknown');
    expect(result[0]!.error?.message).toBe('Search failed');
  });
});
