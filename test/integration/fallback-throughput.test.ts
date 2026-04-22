
import { describe, it, expect } from 'vitest';
import { performFallbackSearch } from '../../src/web-research/fallback-search.ts';

/**
 * Advanced Throughput Validation (10 Simultaneous Searches)
 * 
 * Verifies that the new Browser Pool and Parallel Fallback logic
 * can handle 10 concurrent 2-page searches with high fidelity.
 */
describe('DuckDuckGo Lite High-Capacity Throughput', () => {
  
  it('should sustain high-fidelity searches with multi-process capacity', async () => {
    const queries = [
      "latest advances in fusion energy 2026",
      "rust programming language concurrency patterns",
      "history of ancient mesoamerican civilizations",
      "impact of climate change on arctic ecosystems",
      "machine learning model compression techniques",
      "evolution of digital cryptography"
    ];

    console.log(`[Throughput Test] Starting parallel searches...`);
    const startTime = Date.now();
    
    // performFallbackSearch uses internal concurrency of 5 and the Browser Pool
    const resultMap = await performFallbackSearch(queries);
    
    const duration = (Date.now() - startTime) / 1000;
    console.log(`[Throughput Test] Completed ${queries.length} complex searches in ${duration.toFixed(2)}s`);

    queries.forEach((q) => {
      const results = resultMap.get(q) || [];
      console.log(`Query "${q}": ${results.length} relevant results`);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThanOrEqual(10);
    });

    const totalResults = Array.from(resultMap.values()).reduce((acc, res) => acc + res.length, 0);
    console.log(`[Throughput Test] Total results retrieved: ${totalResults}`);
    expect(totalResults).toBeGreaterThanOrEqual(100);

  }, 180000); // 3 minute timeout
});
