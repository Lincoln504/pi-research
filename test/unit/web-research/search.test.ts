import { describe, it, expect, vi, beforeEach } from 'vitest';
import { search } from '../../../src/web-research/search.ts';

vi.mock('../../../src/web-research/utils.ts', () => ({
  getSearxngUrl: vi.fn().mockReturnValue('http://localhost:8080'),
  incrementConnectionCount: vi.fn(),
  decrementConnectionCount: vi.fn()
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    warn: vi.fn(),
    log: vi.fn(),
    error: vi.fn()
  }
}));

describe('search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock global fetch
    globalThis.fetch = vi.fn();
  });

  it('should return results for a successful search', async () => {
    const mockResults = [{ url: 'http://example.com', title: 'Example', content: 'Content' }];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ results: mockResults })
    } as Response);

    const result = await search(['test query']);
    
    expect(result).toHaveLength(1);
    expect(result[0]!.results).toEqual(mockResults);
    expect(result[0]!.error).toBeUndefined();
  });

  it('should handle empty results', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] })
    } as Response);

    const result = await search(['empty query']);
    
    expect(result).toHaveLength(1);
    expect(result[0]!.results).toHaveLength(0);
    expect(result[0]!.error?.type).toBe('empty_results');
  });

  it('should classify timeout errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('AbortError'));

    const result = await search(['timeout query']);
    
    expect(result[0]!.error?.type).toBe('timeout');
  });

  it('should classify network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await search(['network query']);
    
    expect(result[0]!.error?.type).toBe('network_error');
  });

  it('should handle non-ok responses', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    } as Response);

    const result = await search(['server error query']);
    
    expect(result[0]!.error?.type).toBe('service_unavailable');
  });
});
